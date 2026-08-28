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

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;
const REDIS_PROTOCOLS = new Set(['redis:', 'rediss:']);

const queueProducerOptionsSchema = z
  .object({
    redisUrl: z.string().trim().min(1),
    readyTimeoutMs: z.number().int().positive().max(120_000).optional(),
    publishTimeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();

export type QueueProducerOptions = Readonly<{
  readonly redisUrl: string;
  readonly readyTimeoutMs?: number;
  readonly publishTimeoutMs?: number;
}>;

export type EnqueuedQueueJob = Readonly<{
  readonly jobId: string;
  readonly jobName: JobName;
  readonly queueName: QueueName;
}>;

export interface QueueStateObservation {
  readonly depth: number;
  /** Age of the oldest waiting or transport-delayed job, zero when empty. */
  readonly oldestJobAgeSeconds: number;
  readonly queueName: QueueName;
}

export interface QueueProducer {
  publish(job: QueueJob): Promise<EnqueuedQueueJob>;
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

export class QueuePublishTimeoutError extends Error {
  public override readonly name = 'QueuePublishTimeoutError';

  public constructor() {
    super('Queue publish exceeded its bounded timeout');
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
} {
  const parsed = queueProducerOptionsSchema.safeParse(options);

  if (!parsed.success) {
    throw new QueueConfigurationError('Redis URL configuration is invalid');
  }

  return {
    redisUrl: parseRedisUrl(parsed.data.redisUrl),
    readyTimeoutMs: parsed.data.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    publishTimeoutMs:
      parsed.data.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
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
  private lifecycle: 'open' | 'closed' = 'open';
  private redisReady = false;

  public constructor(options: QueueProducerOptions) {
    const parsedOptions = parseProducerOptions(options);

    this.readyTimeoutMs = parsedOptions.readyTimeoutMs;
    this.publishTimeoutMs = parsedOptions.publishTimeoutMs;
    this.redis = new Redis(parsedOptions.redisUrl, {
      connectTimeout: parsedOptions.readyTimeoutMs,
      enableOfflineQueue: false,
      // Producers fail fast so an outbox lease can be released/retried. A
      // Worker uses a separate blocking connection with null retries.
      maxRetriesPerRequest: 1,
    });
    this.redisReady = this.redis.status === 'ready';

    this.redis.on('ready', () => {
      if (this.lifecycle === 'open') {
        this.redisReady = true;
      }
    });
    this.redis.on('close', () => {
      this.redisReady = false;
    });
    this.redis.on('end', () => {
      this.redisReady = false;
    });
    this.redis.on('error', () => {
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

  public async publish(job: QueueJob): Promise<EnqueuedQueueJob> {
    const parsed = parseQueueJob(job);
    const jobId = jobIdForOutboxEvent(parsed.data.outboxEventId);
    const queueName = QUEUE_FOR_JOB[parsed.name];

    if (!this.isReady()) {
      throw new QueueNotReadyError();
    }

    await this.withPublishTimeout(
      this.queueFor(parsed).add(
        parsed.name,
        parsed.data,
        toJobOptions(queueName, jobId),
      ),
    );

    return {
      jobId,
      jobName: parsed.name,
      queueName,
    };
  }

  public async observe(): Promise<readonly QueueStateObservation[]> {
    if (!this.isReady()) {
      throw new QueueNotReadyError();
    }

    const observedAt = Date.now();
    return this.withPublishTimeout(
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
    );
  }

  public async close(): Promise<void> {
    if (this.lifecycle === 'closed') {
      return;
    }

    this.lifecycle = 'closed';
    this.redisReady = false;

    const closeResults = await Promise.allSettled([
      ...Object.values(this.queues).map((queue) => queue.close()),
      this.redis.quit(),
    ]);
    const rejected = closeResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    if (rejected !== undefined) {
      throw rejected.reason;
    }
  }

  private queueFor(job: QueueJob): Queue {
    return this.queues[QUEUE_FOR_JOB[job.name]];
  }

  private isOpen(): boolean {
    return this.lifecycle === 'open';
  }

  private withPublishTimeout<T>(operation: Promise<T>): Promise<T> {
    return this.withTimeout(
      operation,
      this.publishTimeoutMs,
      new QueuePublishTimeoutError(),
    );
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
