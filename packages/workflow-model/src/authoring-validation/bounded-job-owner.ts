import type { Worker, WorkerOptions } from 'node:worker_threads';
import { inspectJsonDocumentAdmission } from '../graph/admission.js';
import { CANONICAL_JSON_MAX_DEPTH } from '../canonical-json.js';
import {
  AUTHORING_VALIDATION_BUDGET as budget,
  AuthoringValidationUnavailableError,
  type AuthoringValidationUnavailableReason,
} from './contracts.js';

export type Limits = Readonly<{
  maxActive: number;
  maxQueued: number;
  maxQueuedBytes: number;
  queueMs: number;
  startupMs: number;
  parseMs: number;
  terminationMs: number;
}>;
export type AuthoringWorkerReply =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'started'; id: number }>
  | Readonly<{ kind: 'result'; id: number; report: unknown }>
  | Readonly<{
      kind: 'unavailable';
      id: number;
      reason: 'report_limit' | 'worker_failed';
    }>;

export interface JobAdapter {
  readonly retainPrepared?: boolean;
  spawn(resourceLimits: NonNullable<WorkerOptions['resourceLimits']>): Worker;
  decodeReply(input: unknown): AuthoringWorkerReply;
  validateResult(report: unknown, prepared: unknown): unknown;
}
interface PendingBatch {
  id: number;
  bytes: number;
  payload: unknown;
  prepared: unknown;
  adapter: JobAdapter;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  queueDeadline: number | undefined;
  resolve: (report: unknown) => void;
  reject: (error: AuthoringValidationUnavailableError) => void;
}
interface ActiveBatch {
  worker: Worker;
  exited: boolean;
  stop: (reason: AuthoringValidationUnavailableReason) => Promise<void>;
}

/** One runtime-owned, bounded authoring parser. Never evaluates expressions. */
export class BoundedAuthoringJobOwner {
  readonly #limits: Limits;
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
      if (
        !Number.isSafeInteger(value) ||
        value < (key === 'maxQueued' || key === 'maxQueuedBytes' ? 0 : 1) ||
        value > maximum
      )
        throw new RangeError(
          'Authoring validator options exceed operational bounds',
        );
    }
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

  assertOpen(signal?: AbortSignal): void {
    if (this.#closed) throw new AuthoringValidationUnavailableError('closed');
    if (signal?.aborted)
      throw new AuthoringValidationUnavailableError('canceled');
  }

  async submit(
    payload: unknown,
    bytes: number,
    adapter: JobAdapter,
    submittedAt: number,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<unknown> {
    if (this.#closed) throw new AuthoringValidationUnavailableError('closed');
    if (options.signal?.aborted)
      throw new AuthoringValidationUnavailableError('canceled');
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > budget.envelopeBytes
    )
      throw new AuthoringValidationUnavailableError('payload_limit');
    const inspected = inspectJsonDocumentAdmission(payload, {
      bytes: budget.envelopeBytes,
      depth: CANONICAL_JSON_MAX_DEPTH,
    });
    if (
      !inspected.ok ||
      typeof inspected.snapshot !== 'object' ||
      inspected.snapshot === null ||
      Array.isArray(inspected.snapshot)
    )
      throw new AuthoringValidationUnavailableError('payload_limit');
    payload = inspected.snapshot;
    bytes = inspected.bytes;
    if (options.signal?.aborted)
      throw new AuthoringValidationUnavailableError('canceled');
    if (
      this.#active.size >= this.#limits.maxActive &&
      (this.#queue.length >= this.#limits.maxQueued ||
        this.#queuedBytes + bytes > this.#limits.maxQueuedBytes)
    )
      throw new AuthoringValidationUnavailableError('overloaded');
    return new Promise<unknown>((resolve, reject) => {
      const job: PendingBatch = {
        id: ++this.#nextId,
        bytes,
        payload,
        prepared: payload,
        adapter,
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
    job.prepared = undefined;
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
      job.prepared = undefined;
      job.reject(new AuthoringValidationUnavailableError('queue_timeout'));
      return;
    }
    if (job.signal?.aborted) {
      job.payload = undefined;
      job.prepared = undefined;
      job.reject(new AuthoringValidationUnavailableError('canceled'));
      return;
    }
    let worker: Worker;
    try {
      worker = job.adapter.spawn({
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 4,
      });
    } catch {
      job.payload = undefined;
      job.prepared = undefined;
      job.reject(new AuthoringValidationUnavailableError('worker_failed'));
      return;
    }
    const exit = Promise.withResolvers<undefined>();
    let finished = false;
    let settled = false;
    let outcomeReason: AuthoringValidationUnavailableReason | undefined;
    let ready = false;
    let started = false;
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
      report?: unknown,
    ): Promise<void> => {
      // A received report is provisional until termination and caller settlement.
      if (
        !settled &&
        (reason === 'canceled' || reason === 'closed') &&
        outcomeReason !== 'canceled' &&
        outcomeReason !== 'closed'
      )
        outcomeReason = reason;
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
        if (!terminated)
          job.reject(
            new AuthoringValidationUnavailableError('termination_failed'),
          );
        else if (outcomeReason !== undefined)
          job.reject(new AuthoringValidationUnavailableError(outcomeReason));
        else if (report !== undefined) job.resolve(report);
        else
          job.reject(
            new AuthoringValidationUnavailableError('invalid_response'),
          );
        job.prepared = undefined;
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
    const onMessage = (input: unknown) => {
      if (finished) return;
      try {
        if (
          Buffer.byteLength(JSON.stringify(input)) >
          budget.reportBytes + 256
        ) {
          void finish('report_limit');
          return;
        }
        const message = job.adapter.decodeReply(input);
        if (message.kind === 'ready') {
          if (ready) {
            void finish('invalid_response');
            return;
          }
          ready = true;
          clearTimeout(deadline);
          deadline = setTimeout(() => {
            void finish('parse_timeout');
          }, this.#limits.parseMs);
          if (
            typeof job.payload !== 'object' ||
            job.payload === null ||
            Array.isArray(job.payload)
          ) {
            void finish('invalid_response');
            return;
          }
          worker.postMessage({ id: job.id, ...job.payload });
          job.payload = undefined;
          if (job.adapter.retainPrepared === false) job.prepared = undefined;
          return;
        }
        if (message.id !== job.id || !ready) {
          void finish('invalid_response');
          return;
        }
        if (message.kind === 'started') {
          if (started) {
            void finish('invalid_response');
            return;
          }
          started = true;
        } else if (!started) void finish('invalid_response');
        else if (message.kind === 'unavailable') void finish(message.reason);
        else {
          const report = job.adapter.validateResult(
            message.report,
            job.prepared,
          );
          void finish(undefined, report);
        }
      } catch (error: unknown) {
        void finish(
          error instanceof AuthoringValidationUnavailableError
            ? error.reason
            : 'invalid_response',
        );
      }
    };
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
