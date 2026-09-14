import { Worker } from 'node:worker_threads';
import { canonicalizeJson, inspectJsonValue } from '../canonical-json.js';
import {
  EXPRESSION_POLICY_V1,
  JSONATA_EVALUATOR_DIAGNOSTICS,
  expressionError,
  projectExpressionContext,
  validateExpression,
  type ExpressionContextV1,
  type ExpressionEvaluator,
  type ExpressionRequest,
  type ExpressionResult,
  type ExpressionWorkerFactory,
} from './policy.js';

const WORKER_RUNTIME_URL = new URL(
  import.meta.url.endsWith('.ts')
    ? '../expression-worker-runtime.ts'
    : '../expression-worker-runtime.js',
  import.meta.url,
);

interface Pending {
  readonly request: ExpressionRequest;
  readonly resolve: (result: ExpressionResult) => void;
  queuedAbort: (() => void) | undefined;
}

function workerCleanupError(error: unknown): Error {
  try {
    if (error instanceof Error) return error;
  } catch {
    // Retain hostile termination failures only as opaque causes.
  }
  return new Error('Evaluator worker termination failed', { cause: error });
}

export class JsonataEvaluator implements ExpressionEvaluator {
  readonly #maxActive: number;
  readonly #maxQueued: number;
  readonly #startupTimeoutMs: number;
  readonly #workerFactory: ExpressionWorkerFactory;
  #active = 0;
  #workerCreations = 0;
  #peakWorkers = 0;
  #closed = false;
  #shutdownPromise: Promise<void> | undefined;
  readonly #queue: Pending[] = [];
  readonly #workers = new Set<Worker>();
  readonly #terminations = new WeakMap<Worker, Promise<void>>();
  readonly #shutdownFinishes = new Map<Worker, () => void>();
  constructor(
    options: {
      readonly maxActive?: number;
      readonly maxQueued?: number;
      readonly startupTimeoutMs?: number;
      readonly workerFactory?: ExpressionWorkerFactory;
    } = {},
  ) {
    this.#maxActive = options.maxActive ?? EXPRESSION_POLICY_V1.maxActive;
    this.#maxQueued = options.maxQueued ?? EXPRESSION_POLICY_V1.maxQueued;
    this.#startupTimeoutMs =
      options.startupTimeoutMs ?? EXPRESSION_POLICY_V1.startupTimeoutMs;
    this.#workerFactory =
      options.workerFactory ??
      ((runtimeUrl, workerOptions) => new Worker(runtimeUrl, workerOptions));
    if (
      !Number.isSafeInteger(this.#maxActive) ||
      this.#maxActive < 1 ||
      this.#maxActive > EXPRESSION_POLICY_V1.maxActive ||
      !Number.isSafeInteger(this.#maxQueued) ||
      this.#maxQueued < 0 ||
      this.#maxQueued > EXPRESSION_POLICY_V1.maxQueued ||
      !Number.isSafeInteger(this.#startupTimeoutMs) ||
      this.#startupTimeoutMs < 1 ||
      this.#startupTimeoutMs > EXPRESSION_POLICY_V1.startupTimeoutMs
    )
      throw new RangeError('evaluator pool options exceed policy v1 bounds');
  }
  diagnostics(): Readonly<{
    isolation: 'bounded_one_shot_worker';
    workerCreations: number;
    peakWorkers: number;
  }> {
    return Object.freeze({
      isolation: JSONATA_EVALUATOR_DIAGNOSTICS.isolation,
      workerCreations: this.#workerCreations,
      peakWorkers: this.#peakWorkers,
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
    const validation = validateExpression(
      request.expression,
      request.policyVersion,
    );
    if (validation.kind === 'error') return Promise.resolve(validation);
    let context: ExpressionContextV1;
    let inspection;
    try {
      context = projectExpressionContext(request.context);
      inspection = inspectJsonValue(context);
    } catch (cause) {
      return Promise.resolve(
        expressionError(
          'evaluation_failed',
          cause instanceof Error ? cause.message : 'invalid context',
        ),
      );
    }
    for (const [limit, actual, maximum] of [
      ['input_bytes', inspection.bytes, EXPRESSION_POLICY_V1.inputBytes],
      ['input_depth', inspection.depth, EXPRESSION_POLICY_V1.inputDepth],
      ['input_members', inspection.members, EXPRESSION_POLICY_V1.inputMembers],
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
        request: {
          ...request,
          context,
        },
        resolve,
        queuedAbort: undefined,
      };
      if (request.signal) {
        pending.queuedAbort = () => {
          const index = this.#queue.indexOf(pending);
          if (index >= 0) {
            this.#queue.splice(index, 1);
            resolve(expressionError('canceled', 'queued evaluation canceled'));
          }
        };
        request.signal.addEventListener('abort', pending.queuedAbort, {
          once: true,
        });
      }
      this.#queue.push(pending);
      this.#drain();
    });
  }
  shutdown(): Promise<void> {
    this.#closed = true;
    if (this.#shutdownPromise === undefined) {
      for (const pending of this.#queue.splice(0)) {
        if (pending.queuedAbort)
          pending.request.signal?.removeEventListener(
            'abort',
            pending.queuedAbort,
          );
        pending.resolve(expressionError('canceled', 'evaluator shut down'));
      }
      this.#shutdownPromise = Promise.resolve().then(async () => {
        for (const finish of this.#shutdownFinishes.values()) finish();
        const outcomes = await Promise.allSettled(
          [...this.#workers].map((worker) => this.#terminateWorker(worker)),
        );
        const failures = outcomes.flatMap((outcome) =>
          outcome.status === 'rejected'
            ? [workerCleanupError(outcome.reason)]
            : [],
        );
        const firstFailure = failures[0];
        if (failures.length === 1 && firstFailure !== undefined)
          throw firstFailure;
        if (failures.length > 1)
          throw new AggregateError(failures, 'Evaluator shutdown failed');
      });
    }
    return this.#shutdownPromise;
  }
  #terminateWorker(worker: Worker): Promise<void> {
    const existing = this.#terminations.get(worker);
    if (existing !== undefined) return existing;
    const termination = Promise.resolve()
      .then(() => worker.terminate())
      .then(() => undefined);
    this.#terminations.set(worker, termination);
    void termination.then(
      () => {
        this.#workers.delete(worker);
        this.#shutdownFinishes.delete(worker);
      },
      () => {
        this.#workers.delete(worker);
        this.#shutdownFinishes.delete(worker);
      },
    );
    return termination;
  }
  #drain(): void {
    while (
      !this.#closed &&
      this.#active < this.#maxActive &&
      this.#queue.length > 0
    ) {
      const pending = this.#queue.shift();
      if (!pending) return;
      if (pending.queuedAbort)
        pending.request.signal?.removeEventListener(
          'abort',
          pending.queuedAbort,
        );
      if (pending.request.signal?.aborted) {
        pending.resolve(expressionError('canceled', 'evaluation canceled'));
        continue;
      }
      this.#active += 1;
      try {
        void this.#run(pending).finally(() => {
          this.#active -= 1;
          this.#drain();
        });
      } catch (cause: unknown) {
        this.#active -= 1;
        pending.resolve(
          expressionError(
            'evaluation_failed',
            cause instanceof Error ? cause.message : 'worker setup failed',
          ),
        );
      }
    }
  }
  #run(pending: Pending): Promise<void> {
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const worker = this.#workerFactory(WORKER_RUNTIME_URL, {
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 4,
      },
    });
    this.#workerCreations += 1;
    this.#workers.add(worker);
    this.#peakWorkers = Math.max(this.#peakWorkers, this.#workers.size);
    let settled = false;
    let handedOff = false;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      void finish(
        expressionError('evaluation_failed', 'evaluator startup timed out'),
      );
    }, this.#startupTimeoutMs);
    const finish = async (result: ExpressionResult): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pending.request.signal?.removeEventListener('abort', onAbort);
      await this.#terminateWorker(worker).catch(() => undefined);
      complete();
      pending.resolve(result);
    };
    const onAbort = (): void => {
      void finish(expressionError('canceled', 'evaluation canceled'));
    };
    this.#shutdownFinishes.set(worker, () => {
      void finish(expressionError('canceled', 'evaluator shut down'));
    });
    pending.request.signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('error', (cause: unknown) => {
      void finish(
        expressionError(
          'evaluation_failed',
          cause instanceof Error ? cause.message : 'worker failed',
        ),
      );
    });
    worker.once('exit', (code) => {
      if (!settled)
        void finish(
          this.#closed
            ? expressionError('canceled', 'evaluator shut down')
            : expressionError(
                'evaluation_failed',
                `evaluator worker exited with code ${String(code)}`,
              ),
        );
    });
    worker.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') {
        void finish(
          expressionError('evaluation_failed', 'invalid evaluator response'),
        );
        return;
      }
      const response = message as {
        ready?: boolean;
        started?: boolean;
        ok?: boolean;
        missing?: boolean;
        value?: unknown;
        message?: string;
      };
      if (response.ready) {
        if (handedOff) {
          void finish(
            expressionError(
              'evaluation_failed',
              'duplicate evaluator readiness',
            ),
          );
          return;
        }
        handedOff = true;
        try {
          worker.postMessage({
            expression: pending.request.expression,
            context: pending.request.context,
          });
        } catch (cause: unknown) {
          void finish(
            expressionError(
              'evaluation_failed',
              cause instanceof Error ? cause.message : 'worker handoff failed',
            ),
          );
        }
        return;
      }
      if (response.started) {
        if (!handedOff) {
          void finish(
            expressionError(
              'evaluation_failed',
              'evaluator started before readiness',
            ),
          );
          return;
        }
        if (started) {
          void finish(
            expressionError('evaluation_failed', 'duplicate evaluator start'),
          );
          return;
        }
        started = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void finish(
            expressionError(
              'timed_out',
              `evaluation exceeded ${String(EXPRESSION_POLICY_V1.timeoutMs)} ms`,
            ),
          );
        }, EXPRESSION_POLICY_V1.timeoutMs);
        return;
      }
      if (!started) {
        void finish(
          expressionError('evaluation_failed', 'evaluator result before start'),
        );
        return;
      }
      if (!response.ok) {
        void finish(
          expressionError(
            'evaluation_failed',
            response.message ?? 'evaluation failed',
          ),
        );
        return;
      }
      if (response.missing) {
        void finish({ kind: 'missing' });
        return;
      }
      try {
        const value = canonicalizeJson(response.value);
        const output = inspectJsonValue(value);
        for (const [limit, actual, maximum] of [
          ['output_bytes', output.bytes, EXPRESSION_POLICY_V1.outputBytes],
          ['output_depth', output.depth, EXPRESSION_POLICY_V1.outputDepth],
          [
            'output_members',
            output.members,
            EXPRESSION_POLICY_V1.outputMembers,
          ],
        ] as const)
          if (actual > maximum) {
            void finish(
              expressionError(
                'limit_exceeded',
                `${limit} exceeds policy`,
                limit,
              ),
            );
            return;
          }
        void finish({ kind: 'value', value, canonicalBytes: output.bytes });
      } catch (cause) {
        void finish(
          expressionError(
            'evaluation_failed',
            cause instanceof Error ? cause.message : 'non-JSON result',
          ),
        );
      }
    });
    return completion;
  }
}
