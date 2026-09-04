import './server-only.js';

import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

import { QUEUE_CLASS_DEFAULTS } from './defaults.js';
import { parseQueueJob, type QueueJob } from './contracts.js';
import {
  QUEUE_FOR_JOB,
  QUEUE_NAME,
  type JobName,
  type QueueName,
} from './names.js';
import {
  instrumentRedisCommands,
  notifyRedisConnectionEvent,
  observeRedisOperation,
  type RedisTelemetryObserver,
} from './redis-telemetry-contracts.js';
import { createProductionRedisTelemetryObserver } from './redis-telemetry.js';

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const REDIS_PROTOCOLS = new Set(['redis:', 'rediss:']);

const queueProducerOptionsSchema = z
  .object({
    redisUrl: z.string().trim().min(1),
    readyTimeoutMs: z.number().int().positive().max(120_000).optional(),
    publishTimeoutMs: z.number().int().positive().max(120_000).optional(),
    closeTimeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();

export type QueueProducerOptions = Readonly<{
  readonly redisUrl: string;
  readonly readyTimeoutMs?: number;
  readonly publishTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly redisTelemetry?: RedisTelemetryObserver;
}>;

export type EnqueuedQueueJob = Readonly<{
  readonly jobId: string;
  readonly jobName: JobName;
  readonly queueName: QueueName;
}>;

export type QueuePublishResult = EnqueuedQueueJob &
  (
    | Readonly<{ readonly outcome: 'published' }>
    | Readonly<{
        readonly outcome: 'outcome_unknown';
        /** Never rejects; records how the already-started publication settles. */
        readonly settlement: Promise<'failed' | 'published'>;
      }>
  );

export interface QueueStateObservation {
  readonly depth: number;
  /** Age of the oldest waiting job, excluding delayed work; zero when empty. */
  readonly oldestJobAgeSeconds: number;
  readonly queueName: QueueName;
}

export interface QueueProducer {
  /** Returns within the configured deadline without misclassifying a timeout as failure. */
  publish(job: QueueJob): Promise<QueuePublishResult>;
  observe(): Promise<readonly QueueStateObservation[]>;
  isReady(): boolean;
  waitUntilReady(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export class QueueConfigurationError extends Error {
  public override readonly name = 'QueueConfigurationError';

  public constructor(message: string) {
    super(message);
  }
}

export class QueueNotReadyError extends Error {
  public override readonly name = 'QueueNotReadyError';

  public constructor() {
    super('Queue producer Redis connection is not ready');
  }
}

type QueueMap = Readonly<Record<QueueName, Queue>>;

function parseRedisUrl(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new QueueConfigurationError('Redis URL is invalid');
  }

  if (!REDIS_PROTOCOLS.has(parsed.protocol) || parsed.hostname.length === 0) {
    throw new QueueConfigurationError(
      'Redis URL must use redis:// or rediss:// with a hostname',
    );
  }

  return value;
}

function parseProducerOptions(options: QueueProducerOptions): {
  readonly redisUrl: string;
  readonly readyTimeoutMs: number;
  readonly publishTimeoutMs: number;
  readonly closeTimeoutMs: number;
} {
  const parsed = queueProducerOptionsSchema.safeParse({
    publishTimeoutMs: options.publishTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    readyTimeoutMs: options.readyTimeoutMs,
    redisUrl: options.redisUrl,
  });

  if (!parsed.success) {
    throw new QueueConfigurationError('Redis URL configuration is invalid');
  }

  return {
    redisUrl: parseRedisUrl(parsed.data.redisUrl),
    readyTimeoutMs: parsed.data.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    publishTimeoutMs:
      parsed.data.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
    closeTimeoutMs: parsed.data.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
  };
}

export function jobIdForOutboxEvent(outboxEventId: string): string {
  const parsed = z.uuid().safeParse(outboxEventId);

  if (!parsed.success) {
    throw new QueueConfigurationError('Outbox event ID must be a UUID');
  }

  const jobId = `outbox-${parsed.data}`;

  if (/^\d+$/.test(jobId) || jobId.includes(':')) {
    throw new QueueConfigurationError('Derived BullMQ job ID is not safe');
  }

  return jobId;
}

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
      for (const queue of Object.values(this.queues)) void queue.disconnect();
      this.redis.disconnect();
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

  private withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    timeoutError: Error,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(timeoutError);
      }, timeoutMs);
      timeout.unref();

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
              : new Error('Queue publish failed', { cause: error }),
          );
        },
      );
    });
  }
}

export function createQueueProducer(
  options: QueueProducerOptions,
): QueueProducer {
  return new BullMqQueueProducer(options);
}
