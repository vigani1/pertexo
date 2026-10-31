import { performance } from 'node:perf_hooks';
import { Worker } from 'bullmq';
import type { Job as BullMqJob, Processor } from 'bullmq';
import { Redis } from 'ioredis';
import {
  admitQueueDelivery,
  deliveryIdentity,
} from '../jobs/delivery-admission.js';
import { QUEUE_CLASS_DEFAULTS } from '../jobs/defaults.js';
import type { QueueName } from '../jobs/names.js';
import {
  instrumentRedisCommands,
  notifyRedisConnectionEvent,
  observeRedisOperation,
  type RedisTelemetryObserver,
} from '../redis/telemetry-contracts.js';
import type {
  QueueDelivery,
  QueueJobHandler,
  QueueHandlerObservation,
  QueueTraceRunner,
  QueueConsumerObserver,
  QueueConsumerOptions,
  QueueConsumerCloseResult,
  QueueConsumer,
  ActiveExecution,
} from './contract.js';
import { parseConsumerOptions } from './configuration.js';
import {
  QueueConsumerNotReadyError,
  QueueJobTimeoutError,
  QueueConsumerDrainError,
} from './errors.js';
import { TIMED_OUT, abortReason, bounded } from './deadline.js';

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
    if (bullMqSignal?.aborted) {
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
        throw abortReason(execution.controller.signal);
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
      ? Promise.reject(abortReason(execution.controller.signal))
      : new Promise<never>((_resolve, reject) => {
          execution.controller.signal.addEventListener(
            'abort',
            () => {
              reject(abortReason(execution.controller.signal));
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
      this.notifyObserver(() => {
        this.observer?.deliveryFailed?.({
          ...observation,
          ...deliveryIdentity(parsed, job),
          error,
          failureClass: execution.abortFailureClass ?? 'handler',
        });
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      bullMqSignal?.removeEventListener('abort', propagateBullMqAbort);
      this.activeExecutions.delete(execution);
    }
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

  private async pauseForDrain(deadline: number): Promise<boolean> {
    try {
      const pauseResult = await bounded(
        this.worker.pause(true),
        Math.max(1, deadline - Date.now()),
      );
      return pauseResult === TIMED_OUT;
    } catch {
      return true;
    }
  }
  private async waitForActiveExecutions(deadline: number): Promise<boolean> {
    while (this.activeExecutions.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(10, remainingMs));
      });
    }
    return true;
  }
  private abortActiveExecutions(): number {
    const abortedJobs = this.activeExecutions.size;
    const reason = new QueueConsumerDrainError();
    for (const execution of this.activeExecutions) {
      execution.abortFailureClass ??= 'drain';
      execution.controller.abort(reason);
    }
    this.worker.cancelAllJobs(reason.message);
    return abortedJobs;
  }
  private async closeWorker({
    forced,
    deadline,
  }: Readonly<{ forced: boolean; deadline: number }>): Promise<boolean> {
    try {
      const closeResult = await bounded(
        this.worker.close(forced),
        forced ? 1_000 : Math.max(1, deadline - Date.now()),
      );
      return closeResult !== TIMED_OUT;
    } catch {
      return false;
    }
  }
  private async closeRedis({
    workerClosed,
  }: Readonly<{ workerClosed: boolean }>): Promise<boolean> {
    if (!workerClosed) {
      try {
        await bounded(this.worker.disconnect(), 1_000);
      } catch {
        // The owned connection below is still disconnected defensively. The
        // bounded BullMQ disconnect is the best-effort teardown for its
        // separately duplicated blocking connection.
      }
      this.redis.disconnect();
      return true;
    }
    try {
      const quitResult = await bounded(this.redis.quit(), 1_000);
      if (quitResult !== TIMED_OUT) return true;
    } catch {
      // Fall through to the defensive disconnect below.
    }
    this.redis.disconnect();
    return false;
  }
  private async performClose(): Promise<QueueConsumerCloseResult> {
    if (this.lifecycle === 'closed') {
      return { abortedJobs: 0, forced: false };
    }
    this.lifecycle = 'draining';
    this.ready = false;
    const deadline = Date.now() + this.drainTimeoutMs;
    let forced = await this.pauseForDrain(deadline);
    if (!forced) forced = !(await this.waitForActiveExecutions(deadline));
    const abortedJobs = forced ? this.abortActiveExecutions() : 0;
    const workerClosed = await this.closeWorker({
      forced: forced,
      deadline: deadline,
    });
    if (!workerClosed) forced = true;
    if (!(await this.closeRedis({ workerClosed: workerClosed }))) forced = true;
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
