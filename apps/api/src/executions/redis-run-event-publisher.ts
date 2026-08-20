import { Buffer } from 'node:buffer';

import { Redis } from 'ioredis';
import { z } from 'zod';

import { runEventChannel } from './redis-run-event-source.js';

const DEFAULT_PUBLISH_TIMEOUT_MS = 2_000;
const MAX_LIVE_MESSAGE_BYTES = 512;
const REDIS_PROTOCOLS = new Set(['redis:', 'rediss:']);

const optionsSchema = z
  .object({
    publishTimeoutMs: z.number().int().positive().max(60_000).optional(),
    redisUrl: z.string().trim().min(1),
  })
  .strict();

const eventReferenceSchema = z
  .object({
    runId: z.uuid(),
    sequence: z.number().int().positive(),
    workspaceId: z.uuid(),
  })
  .strict();

export interface RedisRunEventPublisherOptions {
  readonly publishTimeoutMs?: number;
  readonly redisUrl: string;
}

export interface RunEventReference {
  readonly runId: string;
  readonly sequence: number;
  readonly workspaceId: string;
}

export interface RunEventNotificationPublisher {
  close(): Promise<void>;
  /** Best-effort latency hint; PostgreSQL has already committed the event. */
  publish(
    reference: RunEventReference,
  ): Promise<{ readonly receivers: number }>;
}

export class RedisRunEventPublisherConfigurationError extends Error {
  public override readonly name = 'RedisRunEventPublisherConfigurationError';
}

export class RedisRunEventPublishError extends Error {
  public override readonly name = 'RedisRunEventPublishError';
}

function parseRedisUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RedisRunEventPublisherConfigurationError('Redis URL is invalid');
  }
  if (!REDIS_PROTOCOLS.has(url.protocol) || url.hostname.length === 0) {
    throw new RedisRunEventPublisherConfigurationError(
      'Redis URL must use redis:// or rediss:// with a hostname',
    );
  }
  return value;
}

export function encodeRunEventReference(reference: RunEventReference): string {
  const parsed = eventReferenceSchema.parse(reference);
  const payload = JSON.stringify({ kind: 'event', ...parsed });
  if (Buffer.byteLength(payload, 'utf8') > MAX_LIVE_MESSAGE_BYTES) {
    throw new RedisRunEventPublishError(
      'Run event notification exceeds its bounded payload limit',
    );
  }
  return payload;
}

export class RedisRunEventPublisher implements RunEventNotificationPublisher {
  private closed = false;
  private readonly createRedis: () => Redis;
  private readonly publishTimeoutMs: number;
  private readonly redis: Redis;

  public constructor(
    options: RedisRunEventPublisherOptions,
    createRedis?: () => Redis,
  ) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new RedisRunEventPublisherConfigurationError(
        'Redis run event publisher configuration is invalid',
      );
    }
    const redisUrl = parseRedisUrl(parsed.data.redisUrl);
    this.publishTimeoutMs =
      parsed.data.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    this.createRedis =
      createRedis ??
      (() =>
        new Redis(redisUrl, {
          connectTimeout: this.publishTimeoutMs,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        }));
    this.redis = this.createRedis();
    this.redis.on('error', () => undefined);
  }

  public close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.redis.disconnect(false);
    return Promise.resolve();
  }

  public async publish(
    reference: RunEventReference,
  ): Promise<{ readonly receivers: number }> {
    if (this.closed) {
      throw new RedisRunEventPublishError('Run event publisher is closed');
    }
    const parsed = eventReferenceSchema.parse(reference);
    const channel = runEventChannel(parsed.workspaceId, parsed.runId);
    const payload = encodeRunEventReference(parsed);
    let timer: NodeJS.Timeout | undefined;
    try {
      const receivers = await Promise.race([
        this.redis.publish(channel, payload),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new RedisRunEventPublishError('Redis publish timed out'));
          }, this.publishTimeoutMs);
        }),
      ]);
      return { receivers };
    } catch (error: unknown) {
      if (error instanceof RedisRunEventPublishError) throw error;
      throw new RedisRunEventPublishError(
        error instanceof Error ? error.message : 'Redis publish failed',
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
