import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { bounded, TIMED_OUT } from './consumption/deadline.js';
import { QUEUE_CLASS_DEFAULTS } from './jobs/defaults.js';
import { jobIdForOutboxEvent } from './jobs/job-id.js';
import { parseQueueJob, type QueueJob } from './jobs/contracts.js';
import { QUEUE_FOR_JOB, QUEUE_NAME, type QueueName } from './jobs/names.js';
import {
  instrumentRedisCommands,
  notifyRedisConnectionEvent,
  observeRedisOperation,
  type RedisTelemetryObserver,
} from './redis/telemetry-contracts.js';
import { createProductionRedisTelemetryObserver } from './redis/telemetry.js';

import type {
  QueueProducerOptions,
  QueuePublishResult,
  QueueStateObservation,
  QueueProducer,
  QueueMap,
} from './publication/contract.js';
import { parseProducerOptions } from './publication/configuration.js';
import {
  QueueConfigurationError,
  QueueNotReadyError,
} from './publication/errors.js';

export {
  type QueueProducerOptions,
  type EnqueuedQueueJob,
  type QueuePublishResult,
  type QueueStateObservation,
  type QueueProducer,
} from './publication/contract.js';
export {
  QueueConfigurationError,
  QueueNotReadyError,
} from './publication/errors.js';
export { jobIdForOutboxEvent } from './jobs/job-id.js';
function createQueues(redis: Redis): QueueMap {
  return {
    [QUEUE_NAME.workflowCoordinator]: new Queue(
      QUEUE_NAME.workflowCoordinator,
      { connection: redis },
    ),
    [QUEUE_NAME.nodeAttempts]: new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redis,
    }),
    [QUEUE_NAME.triggerLifecycle]: new Queue(QUEUE_NAME.triggerLifecycle, {
      connection: redis,
    }),
    [QUEUE_NAME.maintenance]: new Queue(QUEUE_NAME.maintenance, {
      connection: redis,
    }),
  };
}

function toJobOptions(queueName: QueueName, jobId: string): JobsOptions {
  const defaults = QUEUE_CLASS_DEFAULTS[queueName];

  return {
    attempts: defaults.attempts,
    backoff: { ...defaults.backoff },
    removeOnComplete: { ...defaults.removeOnComplete },
    removeOnFail: { ...defaults.removeOnFail },
    jobId,
  };
}

function observeFallbackCleanup(start: () => unknown): void {
  try {
    void Promise.resolve(start()).catch(() => undefined);
  } catch {
    // The primary bounded-close failure remains authoritative.
  }
}

export class BullMqQueueProducer implements QueueProducer {
  private readonly redis: Redis;
  private readonly queues: QueueMap;
  private readonly readyTimeoutMs: number;
  private readonly publishTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly redisTelemetry: RedisTelemetryObserver | undefined;
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private closePromise: Promise<void> | undefined;
  private redisReady = false;

  public constructor(options: QueueProducerOptions) {
    const parsedOptions = parseProducerOptions(options);

    this.readyTimeoutMs = parsedOptions.readyTimeoutMs;
    this.publishTimeoutMs = parsedOptions.publishTimeoutMs;
    this.closeTimeoutMs = parsedOptions.closeTimeoutMs;
    this.redisTelemetry =
      options.redisTelemetry ?? createProductionRedisTelemetryObserver();
    this.redis = instrumentRedisCommands(
      new Redis(parsedOptions.redisUrl, {
        connectTimeout: parsedOptions.readyTimeoutMs,
        enableOfflineQueue: false,
        // Producers fail fast so the outbox owner can retain an uncertain
        // lease and reconcile late settlement. A worker uses a separate
        // blocking connection with null retries.
        maxRetriesPerRequest: 1,
      }),
      this.redisTelemetry,
      'queue_producer',
    );
    this.redisReady = this.redis.status === 'ready';

    this.redis.on('ready', () => {
      notifyRedisConnectionEvent(
        this.redisTelemetry,
        'queue_producer',
        'ready',
      );
      if (this.lifecycle === 'open') {
        this.redisReady = true;
      }
    });
    this.redis.on('close', () => {
      notifyRedisConnectionEvent(
        this.redisTelemetry,
        'queue_producer',
        'close',
      );
      this.redisReady = false;
    });
    this.redis.on('end', () => {
      notifyRedisConnectionEvent(this.redisTelemetry, 'queue_producer', 'end');
      this.redisReady = false;
    });
    this.redis.on('error', () => {
      notifyRedisConnectionEvent(
        this.redisTelemetry,
        'queue_producer',
        'error',
      );
      this.redisReady = false;
    });

    try {
      this.queues = createQueues(this.redis);
    } catch (error: unknown) {
      this.redis.disconnect();
      throw error;
    }
  }

  public isReady(): boolean {
    return this.lifecycle === 'open' && this.redisReady;
  }

  public async waitUntilReady(timeoutMs = this.readyTimeoutMs): Promise<void> {
    return observeRedisOperation(
      this.redisTelemetry,
      'queue_producer',
      'wait_until_ready',
      () => this.performWaitUntilReady(timeoutMs),
    );
  }

  private async performWaitUntilReady(timeoutMs: number): Promise<void> {
    if (this.lifecycle === 'closed') {
      throw new QueueNotReadyError();
    }

    const deadline = Date.now() + timeoutMs;

    while (!this.isReady()) {
      if (!this.isOpen()) {
        throw new QueueNotReadyError();
      }
      if (Date.now() >= deadline) {
        throw new QueueNotReadyError();
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }

    const remainingTimeoutMs = Math.max(1, deadline - Date.now());
    await this.withTimeout(
      Promise.all(
        Object.values(this.queues).map((queue) => queue.waitUntilReady()),
      ),
      remainingTimeoutMs,
      new QueueNotReadyError(),
    );
    if (!this.isReady()) throw new QueueNotReadyError();
  }

  public async publish(job: QueueJob): Promise<QueuePublishResult> {
    return observeRedisOperation(
      this.redisTelemetry,
      'queue_producer',
      'publish',
      () => this.performPublish(job),
    );
  }

  private async performPublish(job: QueueJob): Promise<QueuePublishResult> {
    const parsed = parseQueueJob(job);
    const jobId = jobIdForOutboxEvent(parsed.data.outboxEventId);
    const queueName = QUEUE_FOR_JOB[parsed.name];

    if (!this.isReady()) {
      throw new QueueNotReadyError();
    }

    const enqueued = { jobId, jobName: parsed.name, queueName } as const;
    const publication = this.queueFor(parsed).add(
      parsed.name,
      parsed.data,
      toJobOptions(queueName, jobId),
    );
    const settlement = publication.then(
      () => 'published' as const,
      () => 'failed' as const,
    );
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => {
        resolve(true);
      }, this.publishTimeoutMs);
      timer.unref();
    });
    try {
      const unknown = await Promise.race([
        publication.then(() => false as const),
        timedOut,
      ]);
      return unknown
        ? Object.freeze({ ...enqueued, outcome: 'outcome_unknown', settlement })
        : Object.freeze({ ...enqueued, outcome: 'published' });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  public async observe(): Promise<readonly QueueStateObservation[]> {
    return observeRedisOperation(
      this.redisTelemetry,
      'queue_producer',
      'observe',
      () => this.performObserve(),
    );
  }

  private async performObserve(): Promise<readonly QueueStateObservation[]> {
    if (!this.isReady()) {
      throw new QueueNotReadyError();
    }

    const observedAt = Date.now();
    return this.withTimeout(
      Promise.all(
        Object.entries(this.queues).map(async ([queueName, queue]) => {
          const [depth, waiting] = await Promise.all([
            queue.getJobCountByTypes('waiting', 'delayed'),
            queue.getJobs('waiting', 0, 0, true),
          ]);
          const oldestTimestamp = waiting.reduce<number | undefined>(
            (oldest, job) =>
              oldest === undefined || job.timestamp < oldest
                ? job.timestamp
                : oldest,
            undefined,
          );

          return Object.freeze({
            depth,
            oldestJobAgeSeconds:
              oldestTimestamp === undefined
                ? 0
                : Math.max(0, observedAt - oldestTimestamp) / 1_000,
            queueName: queueName as QueueName,
          });
        }),
      ).then((observations) => Object.freeze(observations)),
      this.publishTimeoutMs,
      new Error('Queue observation exceeded its bounded timeout'),
    );
  }

  public close(): Promise<void> {
    this.closePromise ??= observeRedisOperation(
      this.redisTelemetry,
      'queue_producer',
      'close',
      () => this.performClose(),
    );
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.lifecycle = 'closing';
    this.redisReady = false;
    const settlement = Promise.allSettled([
      ...Object.values(this.queues).map((queue) => queue.close()),
      this.redis.quit(),
    ]);
    try {
      const closeResults = await this.withTimeout(
        settlement,
        this.closeTimeoutMs,
        new Error('Queue producer close exceeded its bounded timeout'),
      );
      const rejected = closeResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (rejected !== undefined) throw rejected.reason;
    } catch (error) {
      for (const queue of Object.values(this.queues))
        observeFallbackCleanup(() => queue.disconnect());
      observeFallbackCleanup(() => {
        this.redis.disconnect();
      });
      throw error;
    } finally {
      this.lifecycle = 'closed';
    }
  }

  private queueFor(job: QueueJob): Queue {
    return this.queues[QUEUE_FOR_JOB[job.name]];
  }

  private isOpen(): boolean {
    return this.lifecycle === 'open';
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    timeoutError: Error,
  ): Promise<T> {
    const result = await bounded(operation, timeoutMs);
    if (result === TIMED_OUT) throw timeoutError;
    return result;
  }
}

export function createQueueProducer(
  options: QueueProducerOptions,
): QueueProducer {
  return new BullMqQueueProducer(options);
}
