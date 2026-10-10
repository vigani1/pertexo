import {
  createServer,
  connect as connectTcp,
  type Server,
  type Socket,
} from 'node:net';

import { Redis } from 'ioredis';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

export type RedisRateLimitFixture = Readonly<{
  control: Redis;
  limiter: RedisRateLimitRuntime;
  proxy: FixtureRedisProxy;
  sentinel: Redis;
}>;

export type RedisRateLimitFixtureDependencies = Readonly<{
  createLimiter: (url: string) => RedisRateLimitRuntime;
  createProxy: (url: string) => Promise<FixtureRedisProxy>;
  createRedis: (url: string) => Redis;
}>;

export async function initializeRedisRateLimitFixture(
  url: string,
  dependencies: RedisRateLimitFixtureDependencies = {
    createLimiter: (proxiedUrl) =>
      new RedisRateLimitRuntime(proxiedUrl, { operationTimeoutMs: 2_000 }),
    createProxy: (fixtureUrl) => FixtureRedisProxy.create(fixtureUrl),
    createRedis: createRedisClient,
  },
): Promise<RedisRateLimitFixture> {
  let control: Redis | undefined;
  let sentinel: Redis | undefined;
  let proxy: FixtureRedisProxy | undefined;
  let limiter: RedisRateLimitRuntime | undefined;
  try {
    control = dependencies.createRedis(url);
    await control.connect();
    await control.ping();
    sentinel = dependencies.createRedis(url);
    await sentinel.connect();
    await sentinel.ping();
    proxy = await dependencies.createProxy(url);
    limiter = dependencies.createLimiter(proxy.url);
    return { control, limiter, proxy, sentinel };
  } catch (error: unknown) {
    const cleanupErrors = await cleanupRedisRateLimitFixture({
      control,
      limiter,
      proxy,
      sentinel,
    });
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Rate-limit integration setup and cleanup failed',
      );
    throw error;
  }
}

export async function cleanupRedisRateLimitFixture(owners: {
  control: Redis | undefined;
  limiter: RedisRateLimitRuntime | undefined;
  proxy: FixtureRedisProxy | undefined;
  sentinel: Redis | undefined;
}): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const close of [
    () => owners.limiter?.close(),
    () => owners.proxy?.close(),
    () => closeRedis(owners.sentinel),
    () => closeRedis(owners.control),
  ])
    await Promise.resolve()
      .then(close)
      .catch((error: unknown) => failures.push(error));
  return failures;
}

function createRedisClient(url: string): Redis {
  return new Redis(url, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
}

async function closeRedis(redis: Redis | undefined): Promise<void> {
  if (redis === undefined) return;
  if (redis.status === 'ready') await redis.quit();
  else redis.disconnect();
}

export class FixtureRedisProxy {
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly server: Server,
    public readonly url: string,
    private readonly clients: Set<Socket>,
    private readonly upstreams: Set<Socket>,
  ) {}

  public static async create(redisUrl: string): Promise<FixtureRedisProxy> {
    const target = new URL(redisUrl);
    if (target.protocol !== 'redis:')
      throw new Error('Rate-limit fault proxy requires a redis:// fixture URL');
    const targetPort = Number(target.port || '6379');
    const clients = new Set<Socket>();
    const upstreams = new Set<Socket>();
    const server = createServer((client) => {
      clients.add(client);
      const upstream = connectTcp({ host: target.hostname, port: targetPort });
      upstreams.add(upstream);
      client.pipe(upstream).pipe(client);
      const closePair = () => {
        clients.delete(client);
        upstreams.delete(upstream);
        client.destroy();
        upstream.destroy();
      };
      client.once('error', closePair);
      upstream.once('error', closePair);
      client.once('close', closePair);
      upstream.once('close', closePair);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error: unknown) {
      if (server.listening)
        await new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        );
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      throw new Error('Rate-limit fault proxy did not acquire a TCP address');
    }
    const proxied = new URL(redisUrl);
    proxied.hostname = '127.0.0.1';
    proxied.port = String(address.port);
    return new FixtureRedisProxy(
      server,
      proxied.toString(),
      clients,
      upstreams,
    );
  }

  public get connectionCount(): number {
    return this.clients.size;
  }

  public disconnectClients(): number {
    const clients = [...this.clients];
    for (const client of clients) client.destroy();
    return clients.length;
  }

  public close(): Promise<void> {
    this.closePromise ??= new Promise<void>((resolve, reject) => {
      for (const client of this.clients) client.destroy();
      for (const upstream of this.upstreams) upstream.destroy();
      this.server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    return this.closePromise;
  }
}
