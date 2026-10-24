import { authoringMessageHandler } from './worker-messages.js';
import type { Limits, PendingBatch, ActiveBatch } from './worker-contract.js';
import { utf8ByteLength } from '../../values/text.js';
import { Worker, type WorkerOptions } from 'node:worker_threads';

import { canonicalizeJson } from '../../values/json/canonical.js';
import { parseWorkflowGraphDraft } from '../../graph/validation/preflight.js';

import type { GraphValidationResult } from '../../graph/validation/contract.js';
import {
  AUTHORING_VALIDATION_BUDGET as budget,
  AuthoringValidationUnavailableError,
  policyProjectionSchema,
  type AuthoringValidationUnavailableReason,
  type WorkflowExpressionPolicyProjection,
  type WorkflowAuthoringValidationOptions,
} from './contracts.js';

const runtimeUrl = new URL(
  import.meta.url.endsWith('.ts')
    ? '../../../dist/authoring/validation/thread.js'
    : './thread.js',
  import.meta.url,
);

/** One runtime-owned, bounded authoring parser. Never evaluates expressions. */
export class WorkflowAuthoringValidator {
  readonly #limits: Limits;
  readonly #workerFactory: (url: URL, options: WorkerOptions) => Worker;
  readonly #queue: PendingBatch[] = [];
  readonly #active = new Map<number, ActiveBatch>();
  readonly #terminations = new WeakMap<Worker, Promise<unknown>>();
  #queuedBytes = 0;
  #nextId = 0;
  #closed = false;
  #shutdown: Promise<void> | undefined;

  constructor(
    options: Partial<Limits> &
      Readonly<{
        workerFactory?: (url: URL, options: WorkerOptions) => Worker;
      }> = {},
  ) {
    this.#limits = {
      maxActive: options.maxActive ?? budget.maxActive,
      maxQueued: options.maxQueued ?? budget.maxQueued,
      maxQueuedBytes: options.maxQueuedBytes ?? budget.maxQueuedBytes,
      queueMs: options.queueMs ?? budget.queueMs,
      startupMs: options.startupMs ?? budget.startupMs,
      parseMs: options.parseMs ?? budget.parseMs,
      terminationMs: options.terminationMs ?? budget.terminationMs,
    };
    const limitNames: readonly (keyof Limits)[] = [
      'maxActive',
      'maxQueued',
      'maxQueuedBytes',
      'queueMs',
      'startupMs',
      'parseMs',
      'terminationMs',
    ];
    for (const key of limitNames) {
      const value = this.#limits[key];
      const maximum = budget[key];
      const invalidLimit =
        !Number.isSafeInteger(value) ||
        value < (key === 'maxQueued' || key === 'maxQueuedBytes' ? 0 : 1) ||
        value > maximum;
      if (invalidLimit)
        throw new RangeError(
          'Authoring validator options exceed operational bounds',
        );
    }
    this.#workerFactory =
      options.workerFactory ??
      ((url, workerOptions) => new Worker(url, workerOptions));
  }

  diagnostics(): Readonly<{
    active: number;
    queued: number;
    queuedBytes: number;
    closed: boolean;
  }> {
    return {
      active: this.#active.size,
      queued: this.#queue.length,
      queuedBytes: this.#queuedBytes,
      closed: this.#closed,
    };
  }

  async validate(
    graphInput: unknown,
    policyInput: WorkflowExpressionPolicyProjection,
    options: WorkflowAuthoringValidationOptions = {},
  ): Promise<GraphValidationResult> {
    const submittedAt = performance.now();
    if (this.#closed) throw new AuthoringValidationUnavailableError('closed');
    if (options.signal?.aborted)
      throw new AuthoringValidationUnavailableError('canceled');
    const graph = parseWorkflowGraphDraft(graphInput);
    let policies: WorkflowExpressionPolicyProjection;
    try {
      policies = policyProjectionSchema.parse(canonicalizeJson(policyInput));
      const definitions = new Set<string>();
      for (const { definition } of policies.definitions) {
        const identity = `${definition.key}\u0000${String(definition.version)}`;
        if (definitions.has(identity))
          throw new Error('Duplicate policy definition');
        definitions.add(identity);
      }
    } catch {
      throw new AuthoringValidationUnavailableError(
        'invalid_policy_projection',
      );
    }
    const payload = {
      graph,
      policies,
      ...(options.workspaceVariableNames === undefined
        ? {}
        : { workspaceVariableNames: [...options.workspaceVariableNames] }),
    };
    const bytes = utf8ByteLength(JSON.stringify(payload));
    if (bytes > budget.envelopeBytes)
      throw new AuthoringValidationUnavailableError('payload_limit');
    if (options.signal?.aborted)
      throw new AuthoringValidationUnavailableError('canceled');
    if (
      this.#active.size >= this.#limits.maxActive &&
      (this.#queue.length >= this.#limits.maxQueued ||
        this.#queuedBytes + bytes > this.#limits.maxQueuedBytes)
    )
      throw new AuthoringValidationUnavailableError('overloaded');
    return new Promise<GraphValidationResult>((resolve, reject) => {
      const job: PendingBatch = {
        id: ++this.#nextId,
        bytes,
        payload,
        signal: options.signal,
        abort: undefined,
        timer: undefined,
        queueDeadline: undefined,
        resolve,
        reject,
      };
      if (this.#active.size < this.#limits.maxActive) this.#start(job);
      else {
        job.queueDeadline = submittedAt + this.#limits.queueMs;
        job.abort = () => {
          this.#removeQueued(job, 'canceled');
        };
        job.signal?.addEventListener('abort', job.abort, { once: true });
        job.timer = setTimeout(
          () => {
            this.#removeQueued(job, 'queue_timeout');
          },
          Math.max(0, this.#limits.queueMs - (performance.now() - submittedAt)),
        );
        this.#queue.push(job);
        this.#queuedBytes += bytes;
      }
    });
  }

  shutdown(): Promise<void> {
    if (this.#shutdown !== undefined) return this.#shutdown;
    this.#closed = true;
    for (const job of [...this.#queue]) this.#removeQueued(job, 'closed');
    const active = [...this.#active.values()];
    this.#shutdown = Promise.all(
      active.map(async (record) => {
        await record.stop('closed');
        if (!record.exited)
          throw new AuthoringValidationUnavailableError('termination_failed');
      }),
    ).then(() => undefined);
    return this.#shutdown;
  }

  #removeQueued(
    job: PendingBatch,
    reason: AuthoringValidationUnavailableReason,
  ): void {
    const index = this.#queue.indexOf(job);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#queuedBytes -= job.bytes;
    this.#clearPending(job);
    job.payload = undefined;
    job.reject(new AuthoringValidationUnavailableError(reason));
  }

  #clearPending(job: PendingBatch): void {
    clearTimeout(job.timer);
    job.timer = undefined;
    if (job.abort !== undefined)
      job.signal?.removeEventListener('abort', job.abort);
    job.abort = undefined;
  }

  #drain(): void {
    while (
      !this.#closed &&
      this.#active.size < this.#limits.maxActive &&
      this.#queue.length > 0
    ) {
      const job = this.#queue.shift();
      if (job === undefined) return;
      this.#queuedBytes -= job.bytes;
      this.#clearPending(job);
      this.#start(job);
    }
  }

  #terminate(worker: Worker): Promise<unknown> {
    let termination = this.#terminations.get(worker);
    if (termination === undefined) {
      termination = Promise.resolve().then(() => worker.terminate());
      this.#terminations.set(worker, termination);
    }
    return termination;
  }

  #start(job: PendingBatch): void {
    if (
      job.queueDeadline !== undefined &&
      performance.now() >= job.queueDeadline
    ) {
      job.payload = undefined;
      job.reject(new AuthoringValidationUnavailableError('queue_timeout'));
      return;
    }
    if (job.signal?.aborted) {
      job.payload = undefined;
      job.reject(new AuthoringValidationUnavailableError('canceled'));
      return;
    }
    let worker: Worker;
    try {
      worker = this.#workerFactory(runtimeUrl, {
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 8,
          stackSizeMb: 4,
        },
      });
    } catch {
      job.payload = undefined;
      job.reject(new AuthoringValidationUnavailableError('worker_failed'));
      return;
    }
    const exit = Promise.withResolvers<undefined>();
    let finished = false;
    let settled = false;
    let outcomeReason: AuthoringValidationUnavailableReason | undefined;
    let deadline: ReturnType<typeof setTimeout>;
    let finishPromise: Promise<void> | undefined;
    const observeTermination = async (): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.all([this.#terminate(worker), exit.promise]).then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => {
              resolve(false);
            }, this.#limits.terminationMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const finish = (
      reason?: AuthoringValidationUnavailableReason,
      report?: GraphValidationResult,
    ): Promise<void> => {
      // A received report is provisional until termination and caller settlement.
      const cancellationOverridesResult =
        !settled &&
        (reason === 'canceled' || reason === 'closed') &&
        outcomeReason !== 'canceled' &&
        outcomeReason !== 'closed';
      if (cancellationOverridesResult) outcomeReason = reason;
      if (finishPromise !== undefined) return finishPromise;
      finished = true;
      outcomeReason ??= reason;
      clearTimeout(deadline);
      job.payload = undefined;
      finishPromise = (async () => {
        const terminated = await observeTermination();
        if (this.#closed && outcomeReason !== 'canceled')
          outcomeReason = 'closed';
        settled = true;
        this.#clearPending(job);
        if (!terminated) {
          job.reject(
            new AuthoringValidationUnavailableError('termination_failed'),
          );
          return;
        }
        if (outcomeReason !== undefined) {
          job.reject(new AuthoringValidationUnavailableError(outcomeReason));
          return;
        }
        if (report !== undefined) {
          job.resolve(report);
          return;
        }
        job.reject(new AuthoringValidationUnavailableError('invalid_response'));
      })();
      return finishPromise;
    };
    const record: ActiveBatch = {
      worker,
      exited: false,
      stop: (reason) => finish(reason),
    };
    this.#active.set(job.id, record);
    const onError = () => {
      if (!finished) void finish('worker_failed');
    };
    const onMessage = authoringMessageHandler({
      job,
      worker,
      isFinished: () => finished,
      finish,
      beginParsing: () => {
        clearTimeout(deadline);
        deadline = setTimeout(() => {
          void finish('parse_timeout');
        }, this.#limits.parseMs);
      },
    });
    worker.on('error', onError);
    worker.on('message', onMessage);
    worker.once('exit', () => {
      record.exited = true;
      exit.resolve(undefined);
      this.#active.delete(job.id);
      worker.off('error', onError);
      worker.off('message', onMessage);
      if (!finished) void finish('worker_failed');
      this.#drain();
    });
    deadline = setTimeout(() => {
      void finish('startup_timeout');
    }, this.#limits.startupMs);
    job.abort = () => {
      void finish('canceled');
    };
    job.signal?.addEventListener('abort', job.abort, { once: true });
    if (job.signal?.aborted) void finish('canceled');
  }
}
