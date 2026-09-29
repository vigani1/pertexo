import { Redis } from 'ioredis';
import { z } from 'zod';

import {
  notifyRedisConnectionEvent,
  observeRedisOperation,
  type RedisClientRole,
  type RedisTelemetryObserver,
} from './redis-telemetry-contracts.js';
import { createProductionRedisTelemetryObserver } from './redis-telemetry.js';
import { normalizeRedisEndpoint } from './redis-endpoint.js';

const DEFAULT_PUBLISH_TIMEOUT_MS = 2_000;

const optionsSchema = z
  .object({
    publishTimeoutMs: z.number().int().positive().max(60_000).optional(),
    redisUrl: z.string().trim().min(1),
  })
  .strict();

export interface BoundedRedisPublisherOptions {
  readonly publishTimeoutMs?: number;
  readonly redisUrl: string;
  readonly redisTelemetry?: RedisTelemetryObserver;
}

/** How a feature publisher names itself and its failures. */
export type BoundedRedisPublisherErrors = Readonly<{
  /** Names the publisher in messages, e.g. "Run event". */
  label: string;
  configuration(message: string): Error;
  publish(message: string): Error;
  isPublishError(error: unknown): boolean;
}>;

/**
 * One Redis connection that publishes small hints and fails fast while
 * disconnected. Hints are never queued offline: subscribers recover from
 * PostgreSQL, so a lost hint must not delay the caller.
 */
export class BoundedRedisPublisher {
  private closed = false;
  private readonly publishTimeoutMs: number;
  private readonly redis: Redis;
  private readonly redisTelemetry: RedisTelemetryObserver | undefined;

  public constructor(
    private readonly role: RedisClientRole,
    private readonly errors: BoundedRedisPublisherErrors,
    options: BoundedRedisPublisherOptions,
    createRedis?: () => Redis,
  ) {
    const parsed = optionsSchema.safeParse({
      publishTimeoutMs: options.publishTimeoutMs,
      redisUrl: options.redisUrl,
    });
    if (!parsed.success)
      throw errors.configuration(
        `Redis ${errors.label.toLowerCase()} publisher configuration is invalid`,
      );
    const redisUrl = normalizeRedisEndpoint(parsed.data.redisUrl, (reason) =>
      errors.configuration(
        reason === 'invalid_url'
          ? 'Redis URL is invalid'
          : 'Redis URL must use redis:// or rediss:// with a hostname',
      ),
    );
    this.publishTimeoutMs =
      parsed.data.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    this.redisTelemetry =
      options.redisTelemetry ?? createProductionRedisTelemetryObserver();
    this.redis =
      createRedis?.() ??
      new Redis(redisUrl, {
        connectTimeout: this.publishTimeoutMs,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
    for (const event of ['ready', 'close', 'end', 'error'] as const) {
      this.redis.on(event, () => {
        notifyRedisConnectionEvent(this.redisTelemetry, role, event);
      });
    }
  }

  public close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.redis.disconnect(false);
    }
    return observeRedisOperation(this.redisTelemetry, this.role, 'close', () =>
      Promise.resolve(),
    );
  }

  public publish(
    channel: string,
    payload: string,
  ): Promise<{ readonly receivers: number }> {
    return observeRedisOperation(
      this.redisTelemetry,
      this.role,
      'publish',
      () => this.performPublish(channel, payload),
    );
  }

  private async performPublish(channel: string, payload: string) {
    if (this.closed)
      throw this.errors.publish(`${this.errors.label} publisher is closed`);
    let timer: NodeJS.Timeout | undefined;
    try {
      const receivers = await Promise.race([
        this.redis.publish(channel, payload),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(this.errors.publish('Redis publish timed out'));
          }, this.publishTimeoutMs);
          timer.unref();
        }),
      ]);
      return { receivers };
    } catch (error: unknown) {
      if (this.errors.isPublishError(error)) throw error;
      throw this.errors.publish(
        error instanceof Error ? error.message : 'Redis publish failed',
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
