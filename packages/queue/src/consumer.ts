import './server-only.js';

import { performance } from 'node:perf_hooks';

import { UnrecoverableError, Worker } from 'bullmq';
import type { Job as BullMqJob, Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

import type { QueueJob } from './contracts.js';
import { admitQueueDelivery } from './delivery-admission.js';
export { InvalidQueueDeliveryError } from './delivery-admission.js';
import { QUEUE_CLASS_DEFAULTS } from './defaults.js';
import { QUEUE_NAME, type QueueName } from './names.js';
import {
  instrumentRedisCommands,
  notifyRedisConnectionEvent,
  observeRedisOperation,
  type RedisTelemetryObserver,
} from './redis-telemetry-contracts.js';
import { createProductionRedisTelemetryObserver } from './redis-telemetry.js';
import { normalizeRedisEndpoint } from './redis-endpoint.js';

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const MAX_CONFIGURED_TIMEOUT_MS = 60 * 60_000;

const consumerOptionsSchema = z
  .object({
    queueName: z.enum([
      QUEUE_NAME.workflowCoordinator,
      QUEUE_NAME.nodeAttempts,
      QUEUE_NAME.triggerLifecycle,
      QUEUE_NAME.maintenance,
    ]),
    redisUrl: z.string().trim().min(1),
    readyTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_CONFIGURED_TIMEOUT_MS)
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_CONFIGURED_TIMEOUT_MS)
      .optional(),
    drainTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_CONFIGURED_TIMEOUT_MS)
      .optional(),
  })
  .strict();

export interface QueueDeliveryTransport {
  readonly attemptsMade: number;
  readonly jobId: string;
}

export type QueueDelivery = QueueJob & {
  readonly transport: QueueDeliveryTransport;
};

export interface QueueHandlerContext {
  /**
   * Aborts when BullMQ cancels the job, the queue-class execution timeout
   * expires, or bounded worker drain expires. Handlers must propagate it to
   * cancellable I/O and may not treat an abort as business completion.
   */
  readonly signal: AbortSignal;
}

export type QueueJobHandler = (
  delivery: QueueDelivery,
  context: QueueHandlerContext,
) => Promise<void>;

export type QueueHandlerFailureClass =
  'drain' | 'handler' | 'timeout' | 'transport';

export interface QueueHandlerObservation {
  readonly jobName: QueueJob['name'];
  readonly queueName: QueueName;
}

/** Activation seam implemented by the observability package with OpenTelemetry. */
export interface QueueTraceRunner {
  run<T>(
    traceparent: string | undefined,
    observation: QueueHandlerObservation,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export type QueueHandlerFinishedObservation = QueueHandlerObservation &
  (
    | {
        readonly durationSeconds: number;
        readonly outcome: 'completed';
      }
    | {
        readonly durationSeconds: number;
        readonly failureClass: QueueHandlerFailureClass;
        readonly outcome: 'failed';
      }
  );

export interface QueueConsumerLifecycleObservation {
  readonly event: 'drain_forced' | 'drain_graceful' | 'ready';
  readonly queueName: QueueName;
}

export interface QueueStallObservation {
  readonly queueName: QueueName;
}

/**
 * Dependency-free lifecycle seam for bounded operational instrumentation.
 * It deliberately exposes no message, workspace, run, or transport IDs.
 */
export interface QueueConsumerObserver {
  consumerLifecycle?(observation: QueueConsumerLifecycleObservation): void;
  handlerFinished(observation: QueueHandlerFinishedObservation): void;
  handlerStarted(observation: QueueHandlerObservation): void;
  jobStalled?(observation: QueueStallObservation): void;
}

export type QueueConsumerOptions = Readonly<{
  readonly queueName: QueueName;
  readonly redisUrl: string;
  readonly handler: QueueJobHandler;
  readonly observer?: QueueConsumerObserver;
  readonly redisTelemetry?: RedisTelemetryObserver;
  readonly traceRunner?: QueueTraceRunner;
  readonly readyTimeoutMs?: number;
  /** Test/deployment override; defaults to the selected queue class. */
  readonly timeoutMs?: number;
  /** Test/deployment override; defaults to the selected queue class. */
  readonly drainTimeoutMs?: number;
}>;

export interface QueueConsumerCloseResult {
  readonly abortedJobs: number;
  readonly forced: boolean;
}

export interface QueueConsumer {
  close(): Promise<QueueConsumerCloseResult>;
  isReady(): boolean;
  waitUntilReady(timeoutMs?: number): Promise<void>;
}

export class QueueConsumerConfigurationError extends Error {
  public override readonly name = 'QueueConsumerConfigurationError';
}

export class QueueConsumerNotReadyError extends Error {
  public override readonly name = 'QueueConsumerNotReadyError';

  public constructor() {
    super('Queue consumer Redis and BullMQ connections are not ready');
  }
}

export class QueueJobTimeoutError extends Error {
  public override readonly name = 'QueueJobTimeoutError';

  public constructor(timeoutMs: number) {
    super(
      `Queue handler exceeded its ${String(timeoutMs)}ms execution timeout`,
    );
  }
}

export class QueueConsumerDrainError extends Error {
  public override readonly name = 'QueueConsumerDrainError';

  public constructor() {
    super('Queue handler was aborted because bounded worker drain expired');
  }
}

/**
 * Explicit policy seam for a handler that has already made the authoritative
 * PostgreSQL decision that this delivery must not be retried by BullMQ.
 */
export function unrecoverableQueueError(message: string): UnrecoverableError {
  return new UnrecoverableError(message);
}

interface ParsedConsumerOptions {
  readonly drainTimeoutMs: number;
  readonly handler: QueueJobHandler;
  readonly observer: QueueConsumerObserver | undefined;
  readonly traceRunner: QueueTraceRunner | undefined;
  readonly queueName: QueueName;
  readonly readyTimeoutMs: number;
  readonly redisUrl: string;
  readonly redisTelemetry: RedisTelemetryObserver | undefined;
  readonly timeoutMs: number;
}

interface ActiveExecution {
  abortFailureClass: QueueHandlerFailureClass | undefined;
  readonly controller: AbortController;
}

const TIMED_OUT = Symbol('timed-out');

function parseRedisUrl(value: string): string {
  return normalizeRedisEndpoint(
    value,
    (reason) =>
      new QueueConsumerConfigurationError(
        reason === 'invalid_url'
          ? 'Redis URL is invalid'
          : 'Redis URL must use redis:// or rediss:// with a hostname',
      ),
  );
}

function parseConsumerOptions(
  options: QueueConsumerOptions,
): ParsedConsumerOptions {
  const candidate = {
    queueName: options.queueName,
    redisUrl: options.redisUrl,
    readyTimeoutMs: options.readyTimeoutMs,
    timeoutMs: options.timeoutMs,
    drainTimeoutMs: options.drainTimeoutMs,
  };
  const parsed = consumerOptionsSchema.safeParse(candidate);

  if (
    !parsed.success ||
    typeof options.handler !== 'function' ||
    (options.observer !== undefined &&
      (typeof options.observer !== 'object' ||
        typeof options.observer.handlerStarted !== 'function' ||
        typeof options.observer.handlerFinished !== 'function')) ||
    (options.traceRunner !== undefined &&
      (typeof options.traceRunner !== 'object' ||
        typeof options.traceRunner.run !== 'function'))
  ) {
    throw new QueueConsumerConfigurationError(
      'Queue consumer configuration is invalid',
    );
  }

  const defaults = QUEUE_CLASS_DEFAULTS[parsed.data.queueName];
  return {
    queueName: parsed.data.queueName,
    redisUrl: parseRedisUrl(parsed.data.redisUrl),
    handler: options.handler,
    observer: options.observer,
    redisTelemetry:
      options.redisTelemetry ?? createProductionRedisTelemetryObserver(),
    traceRunner: options.traceRunner,
    readyTimeoutMs: parsed.data.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    timeoutMs: parsed.data.timeoutMs ?? defaults.timeoutMs,
    drainTimeoutMs: parsed.data.drainTimeoutMs ?? defaults.drainTimeoutMs,
  };
}

function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(TIMED_OUT);
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(
          error instanceof Error
            ? error
            : new Error('Bounded queue operation failed', { cause: error }),
        );
      },
    );
  });
}

export class BullMqQueueConsumer implements QueueConsumer {
  private readonly activeExecutions = new Set<ActiveExecution>();
  private readonly drainTimeoutMs: number;
  private readonly handler: QueueJobHandler;
  private readonly observer: QueueConsumerObserver | undefined;
  private readonly queueName: QueueName;
  private readonly readyTimeoutMs: number;
  private readonly redis: Redis;
  private readonly redisTelemetry: RedisTelemetryObserver | undefined;
  private readonly timeoutMs: number;
  private readonly traceRunner: QueueTraceRunner | undefined;
  private readonly worker: Worker<unknown, void>;
  private lifecycle: 'open' | 'draining' | 'closed' = 'open';
  private ready = false;
  private closePromise: Promise<QueueConsumerCloseResult> | undefined;

  public constructor(options: QueueConsumerOptions) {
    const parsed = parseConsumerOptions(options);
    const defaults = QUEUE_CLASS_DEFAULTS[parsed.queueName];

    this.drainTimeoutMs = parsed.drainTimeoutMs;
    this.handler = parsed.handler;
    this.observer = parsed.observer;
    this.queueName = parsed.queueName;
    this.readyTimeoutMs = parsed.readyTimeoutMs;
    this.timeoutMs = parsed.timeoutMs;
    this.redisTelemetry = parsed.redisTelemetry;
    this.traceRunner = parsed.traceRunner;
    this.redis = instrumentRedisCommands(
      new Redis(parsed.redisUrl, {
        connectTimeout: parsed.readyTimeoutMs,
        // A worker must tolerate transient Redis outages. BullMQ also derives a
        // second, dedicated blocking connection from this consumer-only client.
        maxRetriesPerRequest: null,
      }),
      this.redisTelemetry,
      'queue_consumer',
    );

    const processor: Processor<unknown, void> = (job, _token, signal) =>
      this.process(parsed.queueName, job, signal);

    try {
      this.worker = new Worker(parsed.queueName, processor, {
        connection: this.redis,
        concurrency: defaults.concurrency,
        lockDuration: defaults.lockDurationMs,
        // BullMQ renews its transport lock at the package-owned heartbeat
        // cadence. This is not a business lease or completion heartbeat.
        lockRenewTime: defaults.heartbeatIntervalMs,
        maxStalledCount: defaults.maxStalledCount,
        stalledInterval: defaults.stalledIntervalMs,
      });
    } catch (error: unknown) {
      this.redis.disconnect();
      throw error;
    }

    this.worker.on('ready', () => {
      notifyRedisConnectionEvent(
        this.redisTelemetry,
        'queue_consumer',
        'ready',
      );
      if (this.lifecycle === 'open') {
        this.ready = true;
        this.notifyObserver(() => {
          this.observer?.consumerLifecycle?.({
            event: 'ready',
            queueName: parsed.queueName,
          });
        });
      }
    });
    this.worker.on('error', () => {
      notifyRedisConnectionEvent(
        this.redisTelemetry,
        'queue_consumer',
        'error',
      );
      this.ready = false;
    });
    this.worker.on('closed', () => {
      notifyRedisConnectionEvent(
        this.redisTelemetry,
        'queue_consumer',
        'close',
      );
      this.ready = false;
    });
    this.worker.on('stalled', () => {
      this.notifyObserver(() => {
        this.observer?.jobStalled?.({ queueName: parsed.queueName });
      });
    });
  }

  public isReady(): boolean {
    return (
      this.lifecycle === 'open' &&
      this.ready &&
      this.worker.isRunning() &&
      !this.worker.isPaused()
    );
  }

  public async waitUntilReady(timeoutMs = this.readyTimeoutMs): Promise<void> {
    return observeRedisOperation(
      this.redisTelemetry,
      'queue_consumer',
      'wait_until_ready',
      () => this.performWaitUntilReady(timeoutMs),
    );
  }

  private async performWaitUntilReady(timeoutMs: number): Promise<void> {
    if (this.lifecycle !== 'open') {
      throw new QueueConsumerNotReadyError();
    }

    const result = await bounded(this.worker.waitUntilReady(), timeoutMs);
    if (result === TIMED_OUT || !this.isOpen()) {
      throw new QueueConsumerNotReadyError();
    }

    this.ready = true;
    if (!this.isReady()) {
      throw new QueueConsumerNotReadyError();
    }
  }

  public close(): Promise<QueueConsumerCloseResult> {
    this.closePromise ??= observeRedisOperation(
      this.redisTelemetry,
      'queue_consumer',
      'close',
      () => this.performClose(),
    );
    return this.closePromise;
  }

  private async process(
    queueName: QueueName,
    job: BullMqJob<unknown, unknown>,
    bullMqSignal: AbortSignal | undefined,
  ): Promise<void> {
    if (!this.isOpen()) {
      throw new QueueConsumerDrainError();
    }

    const { parsed, transportJobId } = admitQueueDelivery(queueName, job);

    const execution: ActiveExecution = {
      abortFailureClass: undefined,
      controller: new AbortController(),
    };
    const propagateBullMqAbort = (): void => {
      execution.abortFailureClass ??= 'transport';
      execution.controller.abort(
        bullMqSignal?.reason ?? new Error('BullMQ cancelled the queue job'),
      );
    };
    if (bullMqSignal?.aborted === true) {
      propagateBullMqAbort();
    } else {
      bullMqSignal?.addEventListener('abort', propagateBullMqAbort, {
        once: true,
      });
    }

    this.activeExecutions.add(execution);
    const timeoutError = new QueueJobTimeoutError(this.timeoutMs);
    const timeout = setTimeout(() => {
      execution.abortFailureClass ??= 'timeout';
      execution.controller.abort(timeoutError);
    }, this.timeoutMs);

    const delivery: QueueDelivery = {
      ...parsed,
      transport: { attemptsMade: job.attemptsMade, jobId: transportJobId },
    };
    const handlerPromise = Promise.resolve().then(() => {
      if (execution.controller.signal.aborted) {
        throw this.abortReason(execution.controller.signal);
      }
      const operation = (): Promise<void> =>
        this.handler(delivery, { signal: execution.controller.signal });
      return (
        this.traceRunner?.run(
          parsed.data.traceparent,
          { jobName: parsed.name, queueName },
          operation,
        ) ?? operation()
      );
    });
    const aborted = execution.controller.signal.aborted
      ? Promise.reject(this.abortReason(execution.controller.signal))
      : new Promise<never>((_resolve, reject) => {
          execution.controller.signal.addEventListener(
            'abort',
            () => {
              reject(this.abortReason(execution.controller.signal));
            },
            { once: true },
          );
        });

    const observation: QueueHandlerObservation = {
      jobName: parsed.name,
      queueName,
    };
    const startedAt = performance.now();
    const observerStarted = this.notifyObserver(() => {
      this.observer?.handlerStarted(observation);
    });

    try {
      await Promise.race([handlerPromise, aborted]);
      if (observerStarted) {
        this.notifyObserver(() => {
          this.observer?.handlerFinished({
            ...observation,
            durationSeconds: (performance.now() - startedAt) / 1_000,
            outcome: 'completed',
          });
        });
      }
    } catch (error: unknown) {
      if (observerStarted) {
        this.notifyObserver(() => {
          this.observer?.handlerFinished({
            ...observation,
            durationSeconds: (performance.now() - startedAt) / 1_000,
            failureClass: execution.abortFailureClass ?? 'handler',
            outcome: 'failed',
          });
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      bullMqSignal?.removeEventListener('abort', propagateBullMqAbort);
      this.activeExecutions.delete(execution);
    }
  }

  private abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error('Queue handler was aborted', { cause: signal.reason });
  }

  private isOpen(): boolean {
    return this.lifecycle === 'open';
  }

  private notifyObserver(notify: () => void): boolean {
    try {
      notify();
      return true;
    } catch {
      // Operational telemetry cannot change queue delivery semantics.
      return false;
    }
  }

  private async performClose(): Promise<QueueConsumerCloseResult> {
    if (this.lifecycle === 'closed') {
      return { abortedJobs: 0, forced: false };
    }

    this.lifecycle = 'draining';
    this.ready = false;
    const deadline = Date.now() + this.drainTimeoutMs;
    let forced = false;

    try {
      const pauseResult = await bounded(
        this.worker.pause(true),
        Math.max(1, deadline - Date.now()),
      );
      if (pauseResult === TIMED_OUT) {
        forced = true;
      }
    } catch {
      forced = true;
    }

    while (!forced && this.activeExecutions.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        forced = true;
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(10, remainingMs));
      });
    }

    const abortedJobs = forced ? this.activeExecutions.size : 0;
    if (forced) {
      const reason = new QueueConsumerDrainError();
      for (const execution of this.activeExecutions) {
        execution.abortFailureClass ??= 'drain';
        execution.controller.abort(reason);
      }
      this.worker.cancelAllJobs(reason.message);
    }

    let workerClosed = false;
    try {
      const closeResult = await bounded(
        this.worker.close(forced),
        forced ? 1_000 : Math.max(1, deadline - Date.now()),
      );
      workerClosed = closeResult !== TIMED_OUT;
      if (!workerClosed) {
        forced = true;
      }
    } catch {
      forced = true;
    }

    if (!workerClosed) {
      try {
        await bounded(this.worker.disconnect(), 1_000);
      } catch {
        // The owned connection below is still disconnected defensively. The
        // bounded BullMQ disconnect is the best-effort teardown for its
        // separately duplicated blocking connection.
      }
      this.redis.disconnect();
    } else {
      try {
        const quitResult = await bounded(this.redis.quit(), 1_000);
        if (quitResult === TIMED_OUT) {
          forced = true;
          this.redis.disconnect();
        }
      } catch {
        forced = true;
        this.redis.disconnect();
      }
    }

    this.lifecycle = 'closed';
    this.notifyObserver(() => {
      this.observer?.consumerLifecycle?.({
        event: forced ? 'drain_forced' : 'drain_graceful',
        queueName: this.queueName,
      });
    });
    return { abortedJobs, forced };
  }
}

export function createQueueConsumer(
  options: QueueConsumerOptions,
): QueueConsumer {
  return new BullMqQueueConsumer(options);
}
