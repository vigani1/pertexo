import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';

import { Redis } from 'ioredis';
import { runEventChannel } from '@pertexo/queue/run-event-notifications';
export { runEventChannel } from '@pertexo/queue/run-event-notifications';
import type {
  RedisOperation,
  RedisOperationErrorClass,
  RedisTelemetryObserver,
} from '@pertexo/queue';
import {
  createProductionRedisTelemetryObserver,
  normalizeRedisEndpoint,
} from '@pertexo/queue';
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
  readonly redisTelemetry?: RedisTelemetryObserver;
  readonly subscribeTimeoutMs?: number;
}

function notifyConnectionEvent(
  observer: RedisTelemetryObserver | undefined,
  event: 'close' | 'end' | 'error' | 'ready',
): void {
  try {
    observer?.connectionEvent({
      clientRole: 'run_event_subscriber',
      event,
    });
  } catch {
    // Dependency telemetry cannot change subscription behavior.
  }
}

async function observeOperation<T>(
  observer: RedisTelemetryObserver | undefined,
  operation: RedisOperation,
  execute: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await execute();
    try {
      observer?.operationFinished({
        clientRole: 'run_event_subscriber',
        durationSeconds: (performance.now() - startedAt) / 1_000,
        operation,
        outcome: 'success',
      });
    } catch {
      // Dependency telemetry cannot change subscription behavior.
    }
    return result;
  } catch (error: unknown) {
    let errorClass: RedisOperationErrorClass = 'connection';
    if (error instanceof RedisRunEventSubscribeError) {
      errorClass = error.message.includes('aborted') ? 'aborted' : 'timeout';
    }
    try {
      observer?.operationFinished({
        clientRole: 'run_event_subscriber',
        durationSeconds: (performance.now() - startedAt) / 1_000,
        errorClass,
        operation,
        outcome: 'failure',
      });
    } catch {
      // Dependency telemetry cannot change subscription behavior.
    }
    throw error;
  }
}

export class RedisRunEventSourceConfigurationError extends Error {
  public override readonly name = 'RedisRunEventSourceConfigurationError';
}

class RedisRunEventSubscribeError extends Error {
  public override readonly name = 'RedisRunEventSubscribeError';
}

function parseRedisUrl(value: string): string {
  return normalizeRedisEndpoint(
    value,
    (reason) =>
      new RedisRunEventSourceConfigurationError(
        reason === 'invalid_url'
          ? 'Redis URL is invalid'
          : 'Redis URL must use redis:// or rediss:// with a hostname',
      ),
  );
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
  private readonly redisTelemetry: RedisTelemetryObserver | undefined;

  public constructor(
    options: RedisRunEventSourceOptions,
    createRedis?: () => Redis,
  ) {
    const parsed = optionsSchema.safeParse({
      bufferCapacity: options.bufferCapacity,
      redisUrl: options.redisUrl,
      subscribeTimeoutMs: options.subscribeTimeoutMs,
    });
    if (!parsed.success) {
      throw new RedisRunEventSourceConfigurationError(
        'Redis run event source configuration is invalid',
      );
    }
    this.redisUrl = parseRedisUrl(parsed.data.redisUrl);
    this.bufferCapacity = parsed.data.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    this.subscribeTimeoutMs =
      parsed.data.subscribeTimeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS;
    this.redisTelemetry =
      options.redisTelemetry ?? createProductionRedisTelemetryObserver();
    this.createRedis =
      createRedis ??
      (() =>
        new Redis(this.redisUrl, {
          connectTimeout: this.subscribeTimeoutMs,
          enableOfflineQueue: true,
          maxRetriesPerRequest: null,
        }));
  }

  public async checkReadiness(): Promise<void> {
    const redis = this.createRedis();
    redis.on('error', () => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      await observeOperation(this.redisTelemetry, 'ping', () =>
        Promise.race([
          redis.ping().then(() => undefined),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new RedisRunEventSubscribeError('Redis ping timed out'));
            }, this.subscribeTimeoutMs);
          }),
        ]),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      redis.removeAllListeners();
      redis.disconnect(false);
    }
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
        if (notification !== undefined) queue.push(notification);
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
      observeOperation(this.redisTelemetry, 'resubscribe', () =>
        redis.subscribe(channel).then(() => undefined),
      ).then(
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
    redis.on('close', () => {
      notifyConnectionEvent(this.redisTelemetry, 'close');
      onClose();
    });
    redis.on('end', () => {
      notifyConnectionEvent(this.redisTelemetry, 'end');
      onClose();
    });
    redis.on('ready', () => {
      notifyConnectionEvent(this.redisTelemetry, 'ready');
      onReady();
    });
    // ioredis requires an error listener to avoid process-level error events.
    redis.on('error', () => {
      notifyConnectionEvent(this.redisTelemetry, 'error');
    });

    const performClose = (): Promise<void> => {
      if (closed) return Promise.resolve();
      closed = true;
      input.signal.removeEventListener('abort', onAbort);
      redis.removeAllListeners();
      redis.disconnect(false);
      queue.close();
      return Promise.resolve();
    };
    const close = (): Promise<void> =>
      observeOperation(this.redisTelemetry, 'close', performClose);
    const onAbort = (): void => {
      void close();
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await observeOperation(this.redisTelemetry, 'subscribe', () =>
        subscribeWithBounds(
          redis,
          channel,
          this.subscribeTimeoutMs,
          input.signal,
        ),
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
