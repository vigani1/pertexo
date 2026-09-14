import { describe, expect, it } from 'vitest';

import { createRedisTestNamespace } from './support/redis-test-namespace.js';

class FakeRedisClient {
  readonly calls: { arguments: readonly unknown[]; name: string }[] = [];

  constructor(
    private readonly behavior: Readonly<{
      databaseSize?: number;
      flushError?: Error;
      lockResult?: unknown;
      releaseResult?: unknown;
      releaseError?: Error;
    }> = {},
  ) {}

  connect(): Promise<void> {
    this.calls.push({ name: 'connect', arguments: [] });
    return Promise.resolve();
  }

  dbsize(): Promise<number> {
    this.calls.push({ name: 'dbsize', arguments: [] });
    return Promise.resolve(this.behavior.databaseSize ?? 0);
  }

  disconnect(reconnect?: boolean): void {
    this.calls.push({ name: 'disconnect', arguments: [reconnect] });
  }

  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: readonly (number | string)[]
  ): Promise<unknown> {
    this.calls.push({
      name: 'eval',
      arguments: [script, numberOfKeys, ...arguments_],
    });
    if (this.behavior.releaseError !== undefined)
      return Promise.reject(this.behavior.releaseError);
    return Promise.resolve(this.behavior.releaseResult ?? 1);
  }

  flushdb(): Promise<void> {
    this.calls.push({ name: 'flushdb', arguments: [] });
    return this.behavior.flushError === undefined
      ? Promise.resolve()
      : Promise.reject(this.behavior.flushError);
  }

  quit(): Promise<void> {
    this.calls.push({ name: 'quit', arguments: [] });
    return Promise.resolve();
  }

  set(
    key: string,
    value: string,
    ...arguments_: readonly (number | string)[]
  ): Promise<unknown> {
    this.calls.push({ name: 'set', arguments: [key, value, ...arguments_] });
    return Promise.resolve(
      this.behavior.lockResult === undefined ? 'OK' : this.behavior.lockResult,
    );
  }
}

function fixture(
  controlBehavior: ConstructorParameters<typeof FakeRedisClient>[0] = {},
  targetBehavior: ConstructorParameters<typeof FakeRedisClient>[0] = {},
) {
  const control = new FakeRedisClient(controlBehavior);
  const target = new FakeRedisClient(targetBehavior);
  const urls: string[] = [];
  const namespace = createRedisTestNamespace(
    'redis://:secret@localhost:6379/0',
    14,
    'ownership-proof',
    {
      token: 'fixed-owner-token',
      createClient: (url) => {
        urls.push(url);
        return urls.length === 1 ? control : target;
      },
    },
  );
  return { control, namespace, target, urls };
}

describe('Redis test namespace ownership', () => {
  it('rejects invalid and reserved database identities before constructing clients', () => {
    expect(() =>
      createRedisTestNamespace('redis://localhost', 10, 'valid-owner'),
    ).toThrow(/reserved/u);
    expect(() =>
      createRedisTestNamespace('redis://localhost', 16, 'valid-owner'),
    ).toThrow(/integer/u);
    expect(() =>
      createRedisTestNamespace('redis://localhost', 14, 'INVALID'),
    ).toThrow(/owner name/u);
  });

  it('leases an empty target and releases only its exact owner token', async () => {
    const { control, namespace, target, urls } = fixture();

    await namespace.acquire();
    await namespace.close();

    expect(urls.map((url) => new URL(url).pathname)).toEqual(['/10', '/14']);
    expect(control.calls.find(({ name }) => name === 'set')?.arguments).toEqual(
      [
        'pertexo:test:redis-db:14:owner',
        'ownership-proof:fixed-owner-token',
        'PX',
        3_600_000,
        'NX',
      ],
    );
    expect(target.calls.map(({ name }) => name)).toEqual([
      'connect',
      'dbsize',
      'flushdb',
      'quit',
    ]);
    const release = control.calls.find(({ name }) => name === 'eval');
    expect(release?.arguments.slice(1)).toEqual([
      1,
      'pertexo:test:redis-db:14:owner',
      'ownership-proof:fixed-owner-token',
    ]);
  });

  it('refuses a competing owner without opening or flushing the target', async () => {
    const { control, namespace, target } = fixture({ lockResult: null });

    await expect(namespace.acquire()).rejects.toThrow(/already owned/u);
    await namespace.close();

    expect(target.calls).toEqual([]);
    expect(control.calls.map(({ name }) => name)).toEqual([
      'connect',
      'set',
      'quit',
    ]);
  });

  it('rolls back its exact lease when the target is not empty', async () => {
    const { control, namespace, target } = fixture({}, { databaseSize: 1 });

    await expect(namespace.acquire()).rejects.toThrow(/not empty/u);

    expect(target.calls.map(({ name }) => name)).toEqual([
      'connect',
      'dbsize',
      'disconnect',
    ]);
    expect(control.calls.map(({ name }) => name)).toEqual([
      'connect',
      'set',
      'eval',
      'quit',
    ]);
  });

  it('reports target cleanup and ownership-release failures together', async () => {
    const flushError = new Error('flush failed');
    const releaseError = new Error('release failed');
    const { control, namespace, target } = fixture(
      { releaseError },
      { flushError },
    );
    await namespace.acquire();

    const error = await namespace.close().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      flushError,
      releaseError,
    ]);
    expect(target.calls.map(({ name }) => name)).toEqual([
      'connect',
      'dbsize',
      'flushdb',
      'disconnect',
    ]);
    expect(control.calls.map(({ name }) => name)).toEqual([
      'connect',
      'set',
      'eval',
      'disconnect',
    ]);
  });
});
