import {
  EvaluationProcess,
  type ProcessEvaluation,
} from './evaluation-process.js';
import { lookupWorkspaceVariable } from '../variables/lookup.js';
import { inspectJsonValue } from '../json/canonical.js';
import {
  EXPRESSION_POLICY,
  JSONATA_EVALUATOR_DIAGNOSTICS,
  expressionError,
  projectExpressionContext,
  inspectExpression,
  type ExpressionContext,
  type ExpressionEvaluator,
  type ExpressionRequest,
  type ExpressionResult,
} from './policy.js';

type Pending = Readonly<{
  evaluation: ProcessEvaluation;
  resolve: (result: ExpressionResult) => void;
  onQueuedAbort: () => void;
}>;

export class JsonataEvaluator implements ExpressionEvaluator {
  readonly #maxActive: number;
  readonly #maxQueued: number;
  readonly #startupTimeoutMs: number;
  #active = 0;
  #processStarts = 0;
  #peakProcesses = 0;
  #closed = false;
  #shutdownPromise: Promise<void> | undefined;
  readonly #queue: Pending[] = [];
  readonly #processes = new Set<EvaluationProcess>();
  /** Most recently used last, so a burst's extra processes are the ones that retire. */
  readonly #idle: { process: EvaluationProcess; retire: NodeJS.Timeout }[] = [];
  constructor(
    options: {
      readonly maxActive?: number;
      readonly maxQueued?: number;
      readonly startupTimeoutMs?: number;
    } = {},
  ) {
    this.#maxActive = options.maxActive ?? EXPRESSION_POLICY.maxActive;
    this.#maxQueued = options.maxQueued ?? EXPRESSION_POLICY.maxQueued;
    this.#startupTimeoutMs =
      options.startupTimeoutMs ?? EXPRESSION_POLICY.startupTimeoutMs;
    const invalidOptions =
      !Number.isSafeInteger(this.#maxActive) ||
      this.#maxActive < 1 ||
      this.#maxActive > EXPRESSION_POLICY.maxActive ||
      !Number.isSafeInteger(this.#maxQueued) ||
      this.#maxQueued < 0 ||
      this.#maxQueued > EXPRESSION_POLICY.maxQueued ||
      !Number.isSafeInteger(this.#startupTimeoutMs) ||
      this.#startupTimeoutMs < 1 ||
      this.#startupTimeoutMs > EXPRESSION_POLICY.startupTimeoutMs;
    if (invalidOptions)
      throw new RangeError('evaluator pool options exceed policy v1 bounds');
  }
  diagnostics(): Readonly<{
    isolation: 'bounded_process_pool';
    processStarts: number;
    peakProcesses: number;
  }> {
    return Object.freeze({
      isolation: JSONATA_EVALUATOR_DIAGNOSTICS.isolation,
      processStarts: this.#processStarts,
      peakProcesses: this.#peakProcesses,
    });
  }
  evaluate(request: ExpressionRequest): Promise<ExpressionResult> {
    if (this.#closed)
      return Promise.resolve(
        expressionError('canceled', 'evaluator is shut down'),
      );
    if (request.signal?.aborted)
      return Promise.resolve(
        expressionError('canceled', 'evaluation canceled'),
      );
    const validation = inspectExpression(request.expression);
    if (validation.kind === 'error') return Promise.resolve(validation);
    let context: ExpressionContext;
    let inspection;
    try {
      context = projectExpressionContext(request.context, {
        readsVariables:
          validation.references.names.length > 0 ||
          validation.references.dynamic,
      });
      inspection = inspectJsonValue(context);
    } catch (cause) {
      return Promise.resolve(
        expressionError(
          'evaluation_failed',
          cause instanceof Error ? cause.message : 'invalid context',
        ),
      );
    }
    for (const reference of validation.callbacks) {
      if (
        context.execution?.callbacks[reference.nodeId]?.[reference.field] ===
        undefined
      )
        return Promise.resolve(
          expressionError(
            'callback_unavailable',
            'The callback is unavailable here. Use Test workflow and select an enabled callback Wait in this scope.',
          ),
        );
    }
    for (const name of validation.references.requiredNames) {
      const value = lookupWorkspaceVariable(name, context.variables ?? {});
      if (value.kind === 'error')
        return Promise.resolve(expressionError(value.code, value.message));
    }
    for (const [limit, actual, maximum] of [
      ['input_bytes', inspection.bytes, EXPRESSION_POLICY.inputBytes],
      ['input_depth', inspection.depth, EXPRESSION_POLICY.inputDepth],
      ['input_members', inspection.members, EXPRESSION_POLICY.inputMembers],
    ] as const)
      if (actual > maximum)
        return Promise.resolve(
          expressionError('limit_exceeded', `${limit} exceeds policy`, limit),
        );
    if (
      this.#active >= this.#maxActive &&
      this.#queue.length >= this.#maxQueued
    )
      return Promise.resolve(
        expressionError(
          'limit_exceeded',
          'evaluator pool queue is full',
          'pool_capacity',
        ),
      );
    return new Promise((resolve) => {
      const pending: Pending = {
        evaluation: {
          readsVariables:
            validation.references.names.length > 0 ||
            validation.references.dynamic,
          request: { ...request, context },
          startupTimeoutMs: this.#startupTimeoutMs,
        },
        resolve,
        onQueuedAbort: () => {
          const index = this.#queue.indexOf(pending);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          resolve(expressionError('canceled', 'queued evaluation canceled'));
        },
      };
      request.signal?.addEventListener('abort', pending.onQueuedAbort, {
        once: true,
      });
      this.#queue.push(pending);
      this.#drain();
    });
  }
  shutdown(): Promise<void> {
    this.#closed = true;
    this.#shutdownPromise ??= this.#stopEverything();
    return this.#shutdownPromise;
  }
  async #stopEverything(): Promise<void> {
    for (const pending of this.#queue.splice(0)) {
      pending.evaluation.request.signal?.removeEventListener(
        'abort',
        pending.onQueuedAbort,
      );
      pending.resolve(expressionError('canceled', 'evaluator shut down'));
    }
    for (const { retire } of this.#idle.splice(0)) clearTimeout(retire);
    await Promise.all([...this.#processes].map((process) => process.stop()));
  }
  #drain(): void {
    while (
      !this.#closed &&
      this.#active < this.#maxActive &&
      this.#queue.length > 0
    ) {
      const pending = this.#queue.shift();
      if (!pending) return;
      pending.evaluation.request.signal?.removeEventListener(
        'abort',
        pending.onQueuedAbort,
      );
      if (pending.evaluation.request.signal?.aborted) {
        pending.resolve(expressionError('canceled', 'evaluation canceled'));
        continue;
      }
      this.#active += 1;
      void this.#run(pending);
    }
  }
  async #run(pending: Pending): Promise<void> {
    const result = await this.#evaluateInProcess(pending.evaluation);
    // Freed first, so whoever reads this result can evaluate again at once.
    this.#active -= 1;
    pending.resolve(result);
    this.#drain();
  }
  async #evaluateInProcess(
    evaluation: ProcessEvaluation,
  ): Promise<ExpressionResult> {
    let process: EvaluationProcess;
    try {
      process = this.#acquireProcess();
    } catch {
      // Spawn errors name host paths, and this message can reach whoever built the step.
      return expressionError('unavailable', 'evaluator process failed');
    }
    const outcome = await process.run(evaluation);
    if (outcome.reusable && !process.gone && !this.#closed)
      this.#keepIdle(process);
    return outcome.result;
  }
  #acquireProcess(): EvaluationProcess {
    const idle = this.#idle.pop();
    if (idle !== undefined) {
      clearTimeout(idle.retire);
      return idle.process;
    }
    const process = new EvaluationProcess(() => {
      this.#forget(process);
    });
    this.#processStarts += 1;
    this.#processes.add(process);
    this.#peakProcesses = Math.max(this.#peakProcesses, this.#processes.size);
    return process;
  }
  #keepIdle(process: EvaluationProcess): void {
    process.release();
    const retire = setTimeout(() => {
      this.#forget(process);
      void process.stop();
    }, EXPRESSION_POLICY.processIdleMs);
    retire.unref();
    this.#idle.push({ process, retire });
  }
  #forget(process: EvaluationProcess): void {
    this.#processes.delete(process);
    const index = this.#idle.findIndex((idle) => idle.process === process);
    if (index < 0) return;
    const [idle] = this.#idle.splice(index, 1);
    if (idle !== undefined) clearTimeout(idle.retire);
  }
}
