import './server-only.js';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { Redis } from 'ioredis';
import { z } from 'zod';
import {
  notifyRedisConnectionEvent,
  observeRedisOperation,
  type RedisTelemetryObserver,
} from './redis-telemetry-contracts.js';
import { createProductionRedisTelemetryObserver } from './redis-telemetry.js';

const DEFAULT_PUBLISH_TIMEOUT_MS = 2_000;
const MAX_LIVE_MESSAGE_BYTES = 512;
const REDIS_PROTOCOLS = new Set(['redis:', 'rediss:']);

const optionsSchema = z
  .object({
    publishTimeoutMs: z.number().int().positive().max(60_000).optional(),
    redisUrl: z.string().trim().min(1),
  })
  .strict();
const identitySchema = z
  .object({ runId: z.uuid(), workspaceId: z.uuid() })
  .strict();
const eventReferenceSchema = identitySchema
  .extend({ sequence: z.number().int().positive() })
  .strict();

export interface RunEventNotificationPublisherOptions {
  readonly publishTimeoutMs?: number;
  readonly redisUrl: string;
  readonly redisTelemetry?: RedisTelemetryObserver;
}
export interface RunEventIdentity {
  readonly runId: string;
  readonly workspaceId: string;
}
export interface RunEventReference extends RunEventIdentity {
  readonly sequence: number;
}
export interface RunEventNotificationPublisher {
  close(): Promise<void>;
  publish(
    reference: RunEventReference,
  ): Promise<{ readonly receivers: number }>;
  resync(identity: RunEventIdentity): Promise<{ readonly receivers: number }>;
}

export class RunEventNotificationConfigurationError extends Error {
  public override readonly name = 'RunEventNotificationConfigurationError';
}
export class RunEventNotificationPublishError extends Error {
  public override readonly name = 'RunEventNotificationPublishError';
}

function parseRedisUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RunEventNotificationConfigurationError('Redis URL is invalid');
  }
  if (!REDIS_PROTOCOLS.has(url.protocol) || url.hostname.length === 0)
    throw new RunEventNotificationConfigurationError(
      'Redis URL must use redis:// or rediss:// with a hostname',
    );
  return value;
}

export function runEventChannel(workspaceId: string, runId: string): string {
  const identity = identitySchema.parse({ workspaceId, runId });
  const digest = createHash('sha256')
    .update(`v1\0${identity.workspaceId}\0${identity.runId}`)
    .digest('base64url');
  return `run-events:v1:${digest}`;
}

export function encodeRunEventReference(reference: RunEventReference): string {
  return boundedMessage({
    kind: 'event',
    ...eventReferenceSchema.parse(reference),
  });
}

export function encodeRunEventResync(identity: RunEventIdentity): string {
  identitySchema.parse(identity);
  return boundedMessage({ kind: 'resync' });
}

function boundedMessage(value: unknown): string {
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, 'utf8') > MAX_LIVE_MESSAGE_BYTES)
    throw new RunEventNotificationPublishError(
      'Run event notification exceeds its bounded payload limit',
    );
  return payload;
}

export class RedisRunEventNotificationPublisher implements RunEventNotificationPublisher {
  private closed = false;
  private readonly publishTimeoutMs: number;
  private readonly redis: Redis;
  private readonly redisTelemetry: RedisTelemetryObserver | undefined;

  public constructor(
    options: RunEventNotificationPublisherOptions,
    createRedis?: () => Redis,
  ) {
    const parsed = optionsSchema.safeParse({
      publishTimeoutMs: options.publishTimeoutMs,
      redisUrl: options.redisUrl,
    });
    if (!parsed.success)
      throw new RunEventNotificationConfigurationError(
        'Redis run event publisher configuration is invalid',
      );
    const redisUrl = parseRedisUrl(parsed.data.redisUrl);
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
        notifyRedisConnectionEvent(
          this.redisTelemetry,
          'run_event_publisher',
          event,
        );
      });
    }
  }

  public close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.redis.disconnect(false);
    }
    return observeRedisOperation(
      this.redisTelemetry,
      'run_event_publisher',
      'close',
      () => Promise.resolve(),
    );
  }

  public publish(reference: RunEventReference) {
    const parsed = eventReferenceSchema.parse(reference);
    return this.publishMessage(
      runEventChannel(parsed.workspaceId, parsed.runId),
      encodeRunEventReference(parsed),
    );
  }

  public resync(identity: RunEventIdentity) {
    const parsed = identitySchema.parse(identity);
    return this.publishMessage(
      runEventChannel(parsed.workspaceId, parsed.runId),
      encodeRunEventResync(parsed),
    );
  }

  private async publishMessage(channel: string, payload: string) {
    return observeRedisOperation(
      this.redisTelemetry,
      'run_event_publisher',
      'publish',
      () => this.performPublishMessage(channel, payload),
    );
  }

  private async performPublishMessage(channel: string, payload: string) {
    if (this.closed)
      throw new RunEventNotificationPublishError(
        'Run event publisher is closed',
      );
    let timer: NodeJS.Timeout | undefined;
    try {
      const receivers = await Promise.race([
        this.redis.publish(channel, payload),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new RunEventNotificationPublishError('Redis publish timed out'),
            );
          }, this.publishTimeoutMs);
        }),
      ]);
      return { receivers };
    } catch (error: unknown) {
      if (error instanceof RunEventNotificationPublishError) throw error;
      throw new RunEventNotificationPublishError(
        error instanceof Error ? error.message : 'Redis publish failed',
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
