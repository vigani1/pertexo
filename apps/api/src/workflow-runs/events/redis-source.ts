import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';

import { Redis } from 'ioredis';
import { runEventChannel } from '@pertexo/queue';
export { runEventChannel } from '@pertexo/queue';
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
  type LiveRunEventSource,
  type LiveRunEventSubscription,
} from './stream.js';
import { BoundedNotificationQueue } from './notification-queue.js';
import {
  raceAbort,
  RedisRunEventSubscribeError,
  subscribeWithBounds,
} from './redis-subscribe.js';

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
      errorClass = error.reason;
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

interface SubscribedChannel {
  readonly listeners: Set<BoundedNotificationQueue>;
  readonly ready: Promise<void>;
}
interface SharedSubscriber {
  readonly redis: Redis;
  readonly channels: Map<string, SubscribedChannel>;
  disconnected: boolean;
}

export class RedisRunEventSource implements LiveRunEventSource {
  private subscriber: SharedSubscriber | undefined;
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
              reject(new RedisRunEventSubscribeError('timeout'));
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
    let closed = false;
    const performClose = (): Promise<void> => {
      if (closed) return Promise.resolve();
      closed = true;
      input.signal.removeEventListener('abort', onAbort);
      this.removeListener(channel, queue);
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
        this.addListener(channel, queue, input.signal),
      );
    } catch (error: unknown) {
      await close();
      throw error;
    }
    return {
      close,
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  /** One connection however many pages are open: a client per stream cost 100 for 100. */
  private connect(): SharedSubscriber {
    if (this.subscriber !== undefined) return this.subscriber;
    const redis = this.createRedis();
    const shared: SharedSubscriber = {
      redis,
      channels: new Map(),
      disconnected: false,
    };
    this.subscriber = shared;
    redis.on('message', (channel: string, message: string) => {
      const listeners = shared.channels.get(channel)?.listeners;
      if (
        listeners === undefined ||
        Buffer.byteLength(message, 'utf8') > MAX_LIVE_MESSAGE_BYTES
      )
        return;
      try {
        const notification = safeParseLiveRunEventNotification(
          JSON.parse(message),
        );
        if (notification !== undefined)
          for (const queue of listeners) queue.push(notification);
      } catch {
        // Pub/sub is untrusted transport input. A malformed hint is discarded
        // later valid/reconnect hints still reconstruct from PostgreSQL.
      }
    });
    const onDisconnected = (event: 'close' | 'end'): void => {
      notifyConnectionEvent(this.redisTelemetry, event);
      shared.disconnected = true;
    };
    redis.on('close', () => {
      onDisconnected('close');
    });
    redis.on('end', () => {
      onDisconnected('end');
    });
    redis.on('ready', () => {
      notifyConnectionEvent(this.redisTelemetry, 'ready');
      this.resubscribe(shared);
    });
    // ioredis requires an error listener to avoid process-level error events.
    redis.on('error', () => {
      notifyConnectionEvent(this.redisTelemetry, 'error');
    });
    return shared;
  }

  private async addListener(
    channel: string,
    queue: BoundedNotificationQueue,
    signal: AbortSignal,
  ): Promise<void> {
    const shared = this.connect();
    if (signal.aborted) throw new RedisRunEventSubscribeError('aborted');
    let entry = shared.channels.get(channel);
    if (entry === undefined) {
      const created: SubscribedChannel = {
        listeners: new Set(),
        // Not this caller's signal: another page may be waiting on the same channel.
        ready: subscribeWithBounds(
          shared.redis,
          channel,
          this.subscribeTimeoutMs,
          new AbortController().signal,
        ),
      };
      created.ready.catch(() => {
        if (shared.channels.get(channel) === created)
          shared.channels.delete(channel);
      });
      shared.channels.set(channel, created);
      entry = created;
    }
    entry.listeners.add(queue);
    await raceAbort(entry.ready, signal);
  }

  private removeListener(
    channel: string,
    queue: BoundedNotificationQueue,
  ): void {
    const shared = this.subscriber;
    if (shared === undefined) return;
    const entry = shared.channels.get(channel);
    entry?.listeners.delete(queue);
    if (entry !== undefined && entry.listeners.size > 0) return;
    shared.channels.delete(channel);
    if (shared.channels.size > 0) {
      // Failing leaves a channel nobody reads, which its handler ignores.
      void shared.redis.unsubscribe(channel).catch(() => undefined);
      return;
    }
    this.subscriber = undefined;
    shared.redis.removeAllListeners();
    shared.redis.disconnect(false);
  }

  /** After a lost connection, every open stream re-reads what it missed from PostgreSQL. */
  private resubscribe(shared: SharedSubscriber): void {
    if (!shared.disconnected || shared.channels.size === 0) return;
    const channels = [...shared.channels.keys()];
    observeOperation(this.redisTelemetry, 'resubscribe', () =>
      shared.redis.subscribe(...channels).then(() => undefined),
    ).then(
      () => {
        shared.disconnected = false;
        for (const channel of channels)
          for (const queue of shared.channels.get(channel)?.listeners ?? [])
            queue.push({ kind: 'resync' });
      },
      () => {
        shared.disconnected = true;
      },
    );
  }
}
