import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';

const CONTROL_DATABASE = 10;
const OWNERSHIP_TTL_MILLIS = 60 * 60 * 1_000;

interface RedisTestClient {
  connect(): Promise<unknown>;
  dbsize(): Promise<number>;
  disconnect(reconnect?: boolean): void;
  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: readonly (number | string)[]
  ): Promise<unknown>;
  flushdb(): Promise<unknown>;
  quit(): Promise<unknown>;
  set(
    key: string,
    value: string,
    ...arguments_: readonly (number | string)[]
  ): Promise<unknown>;
}

type RedisTestNamespaceDependencies = Readonly<{
  createClient?: (url: string) => RedisTestClient;
  token?: string;
}>;

export function createRedisTestNamespace(
  configuredUrl: string,
  database: number,
  ownerName: string,
  dependencies: RedisTestNamespaceDependencies = {},
) {
  if (!Number.isInteger(database) || database < 0 || database > 15)
    throw new Error('Redis test database must be an integer from 0 through 15');
  if (database === CONTROL_DATABASE)
    throw new Error('Redis test database 10 is reserved for ownership locks');
  if (!/^[a-z0-9-]+$/u.test(ownerName))
    throw new Error('Redis test namespace owner name is invalid');
  const targetUrl = new URL(configuredUrl);
  targetUrl.pathname = `/${String(database)}`;
  const controlUrl = new URL(configuredUrl);
  controlUrl.pathname = `/${String(CONTROL_DATABASE)}`;
  const token = dependencies.token ?? randomUUID();
  const ownerValue = `${ownerName}:${token}`;
  const lockKey = `pertexo:test:redis-db:${String(database)}:owner`;
  let control: RedisTestClient | undefined;
  let target: RedisTestClient | undefined;
  let acquired = false;

  const client = (url: string): RedisTestClient => {
    if (dependencies.createClient !== undefined)
      return dependencies.createClient(url);
    const redis = new Redis(url, {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    redis.on('error', () => undefined);
    return redis as unknown as RedisTestClient;
  };

  const releaseControl = async (): Promise<void> => {
    const activeControl = control;
    control = undefined;
    if (activeControl === undefined) return;
    try {
      if (acquired) {
        const released = await activeControl.eval(
          `if redis.call('get',KEYS[1]) == ARGV[1] then
             return redis.call('del',KEYS[1])
           end
           return 0`,
          1,
          lockKey,
          ownerValue,
        );
        if (released !== 1)
          throw new Error('Redis test namespace ownership was lost');
      }
      await activeControl.quit();
    } catch (error: unknown) {
      activeControl.disconnect(false);
      throw error;
    } finally {
      acquired = false;
    }
  };

  return Object.freeze({
    database,
    redisUrl: targetUrl.toString(),
    async acquire(): Promise<void> {
      if (acquired) return;
      const nextControl = client(controlUrl.toString());
      control = nextControl;
      try {
        await nextControl.connect();
        const result = await nextControl.set(
          lockKey,
          ownerValue,
          'PX',
          OWNERSHIP_TTL_MILLIS,
          'NX',
        );
        if (result !== 'OK')
          throw new Error(
            `Redis test database ${String(database)} is already owned`,
          );
        acquired = true;
        const nextTarget = client(targetUrl.toString());
        target = nextTarget;
        await nextTarget.connect();
        if ((await nextTarget.dbsize()) !== 0)
          throw new Error(
            `Redis test database ${String(database)} is not empty`,
          );
      } catch (error: unknown) {
        target?.disconnect(false);
        target = undefined;
        let releaseError: unknown;
        await releaseControl().catch((cause: unknown) => {
          releaseError = cause;
        });
        if (releaseError === undefined) throw error;
        throw new AggregateError(
          [error, releaseError],
          'Redis test namespace acquisition and rollback failed',
        );
      }
    },
    async close(): Promise<void> {
      const errors: unknown[] = [];
      const activeTarget = target;
      target = undefined;
      if (activeTarget !== undefined)
        try {
          await activeTarget.flushdb();
          await activeTarget.quit();
        } catch (error: unknown) {
          activeTarget.disconnect(false);
          errors.push(error);
        }
      await releaseControl().catch((error: unknown) => errors.push(error));
      if (errors.length > 0)
        throw new AggregateError(errors, 'Redis test namespace cleanup failed');
    },
  });
}
