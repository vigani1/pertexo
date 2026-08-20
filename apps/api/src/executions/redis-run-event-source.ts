import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { Redis } from 'ioredis';
import { z } from 'zod';

import {
  safeParseLiveRunEventNotification,
  type LiveRunEventNotification,
  type LiveRunEventSource,
  type LiveRunEventSubscription,
} from './run-event-stream.js';

const DEFAULT_BUFFER_CAPACITY = 1_024;
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 5_000;
const MAX_BUFFER_CAPACITY = 4_096;
const MAX_LIVE_MESSAGE_BYTES = 512;
const REDIS_PROTOCOLS = new Set(['redis:', 'rediss:']);

const optionsSchema = z
  .object({
    bufferCapacity: z
      .number()
      .int()
      .positive()
      .max(MAX_BUFFER_CAPACITY)
      .optional(),
    redisUrl: z.string().trim().min(1),
    subscribeTimeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

export interface RedisRunEventSourceOptions {
  readonly bufferCapacity?: number;
  readonly redisUrl: string;
  readonly subscribeTimeoutMs?: number;
}

export class RedisRunEventSourceConfigurationError extends Error {
  public override readonly name = 'RedisRunEventSourceConfigurationError';
}

export class RedisRunEventSubscribeError extends Error {
  public override readonly name = 'RedisRunEventSubscribeError';
}

function parseRedisUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RedisRunEventSourceConfigurationError('Redis URL is invalid');
  }
  if (!REDIS_PROTOCOLS.has(url.protocol) || url.hostname.length === 0) {
    throw new RedisRunEventSourceConfigurationError(
      'Redis URL must use redis:// or rediss:// with a hostname',
    );
  }
  return value;
}

/** Redis channel names reveal neither workspace nor run identifiers. */
export function runEventChannel(workspaceId: string, runId: string): string {
  const identity = z
    .object({ runId: z.uuid(), workspaceId: z.uuid() })
    .strict()
    .parse({ runId, workspaceId });
  const digest = createHash('sha256')
    .update(`v1\0${identity.workspaceId}\0${identity.runId}`)
    .digest('base64url');
  return `run-events:v1:${digest}`;
}

class BoundedNotificationQueue implements AsyncIterable<LiveRunEventNotification> {
  private closed = false;
  private readonly items: LiveRunEventNotification[] = [];
  private readonly waiters: ((
    result: IteratorResult<LiveRunEventNotification>,
  ) => void)[] = [];

  public constructor(private readonly capacity: number) {}

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
    this.items.length = 0;
  }

  public push(notification: LiveRunEventNotification): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: notification });
      return;
    }

    if (this.items.length >= this.capacity) {
      // Coalesce overflow into one PostgreSQL resync. Dropping Redis hints is
      // safe because the durable event log remains authoritative.
      this.items.length = 0;
      this.items.push({ kind: 'resync' });
      return;
    }
    if (
      notification.kind === 'resync' &&
      this.items.some((item) => item.kind === 'resync')
    ) {
      return;
    }
    this.items.push(notification);
  }

  public [Symbol.asyncIterator](): AsyncIterator<LiveRunEventNotification> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ done: false, value: item });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

async function subscribeWithBounds(
  redis: Redis,
  channel: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new RedisRunEventSubscribeError('Run event subscription was aborted');
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      redis.subscribe(channel).then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new RedisRunEventSubscribeError('Redis subscription timed out'),
          );
        }, timeoutMs);
        onAbort = () => {
          reject(
            new RedisRunEventSubscribeError(
              'Run event subscription was aborted',
            ),
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

export class RedisRunEventSource implements LiveRunEventSource {
  private readonly bufferCapacity: number;
  private readonly redisUrl: string;
  private readonly subscribeTimeoutMs: number;
  private readonly createRedis: () => Redis;

  public constructor(
    options: RedisRunEventSourceOptions,
    createRedis?: () => Redis,
  ) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new RedisRunEventSourceConfigurationError(
        'Redis run event source configuration is invalid',
      );
    }
    this.redisUrl = parseRedisUrl(parsed.data.redisUrl);
    this.bufferCapacity = parsed.data.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    this.subscribeTimeoutMs =
      parsed.data.subscribeTimeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS;
    this.createRedis =
      createRedis ??
      (() =>
        new Redis(this.redisUrl, {
          connectTimeout: this.subscribeTimeoutMs,
          enableOfflineQueue: true,
          maxRetriesPerRequest: null,
        }));
  }

  public async subscribe(input: {
    readonly runId: string;
    readonly signal: AbortSignal;
    readonly workspaceId: string;
  }): Promise<LiveRunEventSubscription> {
    const channel = runEventChannel(input.workspaceId, input.runId);
    const queue = new BoundedNotificationQueue(this.bufferCapacity);
    const redis = this.createRedis();
    let closed = false;
    let disconnectedAfterSubscribe = false;
    let subscribed = false;

    const onMessage = (receivedChannel: string, message: string): void => {
      if (
        receivedChannel !== channel ||
        Buffer.byteLength(message, 'utf8') > MAX_LIVE_MESSAGE_BYTES
      ) {
        return;
      }
      try {
        const notification = safeParseLiveRunEventNotification(
          JSON.parse(message),
        );
        if (notification?.kind === 'event') queue.push(notification);
      } catch {
        // Pub/sub is untrusted transport input. A malformed hint is discarded;
        // later valid/reconnect hints still reconstruct from PostgreSQL.
      }
    };
    const onClose = (): void => {
      if (subscribed) disconnectedAfterSubscribe = true;
    };
    const onReady = (): void => {
      if (!subscribed || !disconnectedAfterSubscribe || closed) return;
      redis.subscribe(channel).then(
        () => {
          if (!closed) {
            disconnectedAfterSubscribe = false;
            queue.push({ kind: 'resync' });
          }
        },
        () => {
          disconnectedAfterSubscribe = true;
        },
      );
    };

    redis.on('message', onMessage);
    redis.on('close', onClose);
    redis.on('end', onClose);
    redis.on('ready', onReady);
    // ioredis requires an error listener to avoid process-level error events.
    redis.on('error', () => undefined);

    const close = (): Promise<void> => {
      if (closed) return Promise.resolve();
      closed = true;
      input.signal.removeEventListener('abort', onAbort);
      redis.removeAllListeners();
      redis.disconnect(false);
      queue.close();
      return Promise.resolve();
    };
    const onAbort = (): void => {
      void close();
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await subscribeWithBounds(
        redis,
        channel,
        this.subscribeTimeoutMs,
        input.signal,
      );
      subscribed = true;
    } catch (error: unknown) {
      await close();
      throw error;
    }

    return {
      close,
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }
}
