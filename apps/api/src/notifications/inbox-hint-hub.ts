import { Redis } from 'ioredis';
import {
  createProductionRedisTelemetryObserver,
  normalizeRedisEndpoint,
  parseWorkspaceInboxHint,
  workspaceInboxChannel,
  type RedisTelemetryObserver,
} from '@pertexo/queue';

/** What an open inbox learns: its workspace changed, or hints may be lost. */
export type InboxHintSignal =
  | Readonly<{ kind: 'changed'; revision: string }>
  | Readonly<{ kind: 'resync' }>;

export interface InboxHintSubscription extends AsyncIterable<InboxHintSignal> {
  close(): void;
}

export interface InboxHintSource {
  checkReadiness(): Promise<void>;
  subscribe(workspaceId: string): Promise<InboxHintSubscription>;
  close(): Promise<void>;
}

export type RedisInboxHintHubOptions = Readonly<{
  redisUrl: string;
  subscribeTimeoutMs?: number;
  redisTelemetry?: RedisTelemetryObserver;
}>;

const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 5_000;

/**
 * Holds only the newest undelivered signal. A reader refetches on any signal,
 * so a burst of hints coalesces into one refresh and memory stays constant.
 */
class LatestSignal implements InboxHintSubscription {
  private pending: InboxHintSignal | undefined;
  private waiter:
    ((result: IteratorResult<InboxHintSignal>) => void) | undefined;
  private closed = false;

  public constructor(private readonly onClose: () => void) {}

  public push(signal: InboxHintSignal): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter({ done: false, value: signal });
      return;
    }
    this.pending =
      this.pending?.kind === 'resync' || signal.kind === 'resync'
        ? { kind: 'resync' }
        : signal;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = undefined;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
    this.onClose();
  }

  public [Symbol.asyncIterator](): AsyncIterator<InboxHintSignal> {
    return {
      next: () => {
        const pending = this.pending;
        if (pending !== undefined) {
          this.pending = undefined;
          return Promise.resolve({ done: false, value: pending });
        }
        if (this.closed)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

interface Channel {
  readonly listeners: Set<LatestSignal>;
  readonly subscribed: Promise<void>;
}

/**
 * ADR 055: one Redis subscriber connection per API process, shared by every
 * open inbox. A workspace's channel is subscribed while at least one of its
 * inboxes is open. After a reconnect every open inbox is told to resync.
 */
export class RedisInboxHintHub implements InboxHintSource {
  private readonly channels = new Map<string, Channel>();
  private readonly subscribeTimeoutMs: number;
  private readonly redisTelemetry: RedisTelemetryObserver;
  private readonly createRedis: () => Redis;
  private redis: Redis | undefined;
  private disconnected = false;
  private closed = false;

  public constructor(
    options: RedisInboxHintHubOptions,
    createRedis?: () => Redis,
  ) {
    const redisUrl = normalizeRedisEndpoint(
      options.redisUrl,
      () => new TypeError('Redis inbox hint URL is invalid'),
    );
    this.subscribeTimeoutMs =
      options.subscribeTimeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS;
    this.redisTelemetry =
      options.redisTelemetry ?? createProductionRedisTelemetryObserver();
    this.createRedis =
      createRedis ??
      (() =>
        new Redis(redisUrl, {
          connectTimeout: this.subscribeTimeoutMs,
          enableOfflineQueue: true,
          maxRetriesPerRequest: null,
        }));
  }

  public async checkReadiness(): Promise<void> {
    await withTimeout(
      this.connection().ping(),
      this.subscribeTimeoutMs,
      'Redis inbox hint ping timed out',
    );
  }

  public async subscribe(workspaceId: string): Promise<InboxHintSubscription> {
    if (this.closed) throw new Error('Inbox hint hub is closed');
    const name = workspaceInboxChannel(workspaceId);
    let channel = this.channels.get(name);
    if (channel === undefined) {
      const subscribed = withTimeout(
        this.connection()
          .subscribe(name)
          .then(() => undefined),
        this.subscribeTimeoutMs,
        'Redis inbox hint subscription timed out',
      );
      channel = { listeners: new Set(), subscribed };
      this.channels.set(name, channel);
      const created = channel;
      subscribed.catch(() => {
        if (this.channels.get(name) !== created) return;
        this.channels.delete(name);
        // Redis may still confirm the late subscription; drop it.
        this.redis?.unsubscribe(name).catch(() => undefined);
      });
    }
    const listener = new LatestSignal(() => {
      this.release(name, listener);
    });
    channel.listeners.add(listener);
    try {
      await channel.subscribed;
    } catch (error: unknown) {
      channel.listeners.delete(listener);
      throw error;
    }
    return listener;
  }

  public close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const channel of this.channels.values())
      for (const listener of channel.listeners) listener.close();
    this.channels.clear();
    this.redis?.removeAllListeners();
    this.redis?.disconnect(false);
    this.redis = undefined;
    return Promise.resolve();
  }

  private connection(): Redis {
    if (this.redis !== undefined) return this.redis;
    const redis = this.createRedis();
    const notify = (event: 'close' | 'end' | 'error' | 'ready') => {
      try {
        this.redisTelemetry.connectionEvent({
          clientRole: 'workspace_inbox_subscriber',
          event,
        });
      } catch {
        // Dependency telemetry cannot change subscription behavior.
      }
    };
    redis.on('message', (channel: string, message: string) => {
      const hint = parseWorkspaceInboxHint(message);
      if (hint === undefined) return;
      for (const listener of this.channels.get(channel)?.listeners ?? [])
        listener.push({ kind: 'changed', revision: hint.revision });
    });
    redis.on('close', () => {
      notify('close');
      this.disconnected = true;
    });
    redis.on('end', () => {
      notify('end');
      this.disconnected = true;
    });
    // ioredis resubscribes on reconnect; hints sent meanwhile are lost.
    redis.on('ready', () => {
      notify('ready');
      if (!this.disconnected) return;
      this.disconnected = false;
      for (const channel of this.channels.values())
        for (const listener of channel.listeners)
          listener.push({ kind: 'resync' });
    });
    redis.on('error', () => {
      notify('error');
    });
    this.redis = redis;
    return redis;
  }

  private release(name: string, listener: LatestSignal): void {
    const channel = this.channels.get(name);
    if (!channel?.listeners.delete(listener)) return;
    if (channel.listeners.size > 0 || this.closed) return;
    this.channels.delete(name);
    // Commands on one connection run in order, so a later subscribe wins.
    this.redis?.unsubscribe(name).catch(() => undefined);
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
