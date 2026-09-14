import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createArtifactUploadDatabase } from '../src/execution/artifact-upload.js';
import { withWorkspaceDestructiveOperationLock } from '../src/lifecycle/retention-transaction.js';

describe('artifact upload runtime', () => {
  it('rejects a pool that cannot hold the lifecycle lock and a scoped transaction', () => {
    expect(() =>
      createArtifactUploadDatabase(
        parseDatabaseConfig({
          connectionString: 'postgresql://unused.invalid/pertexo',
          max: 1,
        }),
      ),
    ).toThrow('requires a database pool of at least 2 connections');
  });

  it('reserves pool capacity for transactions while lifecycle locks are held', async () => {
    const firstStarted = Promise.withResolvers<undefined>();
    const releaseFirst = Promise.withResolvers<undefined>();
    const client = {
      query: vi.fn((input: string | { text: string }) =>
        Promise.resolve({
          rows:
            typeof input === 'object' && input.text.includes('unlock')
              ? [{ unlocked: true }]
              : [],
        }),
      ),
      release: vi.fn(),
    };
    const connect = vi.fn(() => Promise.resolve(client));
    const pool = {
      connect,
      options: { max: 2 },
    } as unknown as Pool;
    const first = withWorkspaceDestructiveOperationLock(
      pool,
      '4ecb44e7-9266-4f10-9557-ea93a737f8f5',
      undefined,
      async () => {
        firstStarted.resolve(undefined);
        await releaseFirst.promise;
      },
    );
    await firstStarted.promise;
    const second = withWorkspaceDestructiveOperationLock(
      pool,
      'd4a26d4b-e7b5-49e8-ab78-203c90466dd4',
      undefined,
      () => Promise.resolve(),
    );

    await Promise.resolve();
    expect(connect).toHaveBeenCalledOnce();
    releaseFirst.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('uses every reserved lock slot for pools larger than two', async () => {
    const started = Array.from({ length: 3 }, () =>
      Promise.withResolvers<undefined>(),
    );
    const release = Array.from({ length: 3 }, () =>
      Promise.withResolvers<undefined>(),
    );
    const clients = Array.from({ length: 4 }, () => ({
      query: vi.fn((input: string | { text: string }) =>
        Promise.resolve({
          rows: (typeof input === 'string' ? input : input.text).includes(
            'unlock',
          )
            ? [{ unlocked: true }]
            : [],
        }),
      ),
      release: vi.fn(),
    }));
    const connect = vi.fn(() =>
      Promise.resolve(clients[connect.mock.calls.length - 1]),
    );
    const pool = { connect, options: { max: 4 } } as unknown as Pool;
    const operations = Array.from({ length: 4 }, (_, index) =>
      withWorkspaceDestructiveOperationLock(
        pool,
        `4ecb44e7-9266-4f10-9557-ea93a737f8f${String(index)}`,
        undefined,
        async () => {
          if (index < 3) {
            started[index]?.resolve(undefined);
            await release[index]?.promise;
          }
        },
      ),
    );

    await Promise.all(started.map(({ promise }) => promise));
    expect(connect).toHaveBeenCalledTimes(3);
    release.forEach(({ resolve }) => {
      resolve(undefined);
    });
    await expect(Promise.all(operations)).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it('hands queued permits off in FIFO order', async () => {
    const gates = Array.from({ length: 2 }, () =>
      Promise.withResolvers<undefined>(),
    );
    const order: number[] = [];
    const client = {
      query: vi.fn((input: string | { text: string }) =>
        Promise.resolve({
          rows: (typeof input === 'string' ? input : input.text).includes(
            'unlock',
          )
            ? [{ unlocked: true }]
            : [],
        }),
      ),
      release: vi.fn(),
    };
    const connect = vi.fn(() => Promise.resolve(client));
    const pool = { connect, options: { max: 2 } } as unknown as Pool;
    const operations = Array.from({ length: 3 }, (_, index) =>
      withWorkspaceDestructiveOperationLock(
        pool,
        `4ecb44e7-9266-4f10-9557-ea93a737f90${String(index)}`,
        undefined,
        async () => {
          order.push(index);
          if (index < 2) await gates[index]?.promise;
        },
      ),
    );

    await vi.waitFor(() => {
      expect(order).toEqual([0]);
    });
    gates[0]?.resolve(undefined);
    await vi.waitFor(() => {
      expect(order).toEqual([0, 1]);
    });
    gates[1]?.resolve(undefined);
    await expect(Promise.all(operations)).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(order).toEqual([0, 1, 2]);
  });

  it('skips multiple canceled queued waiters without consuming checkout capacity', async () => {
    const holderStarted = Promise.withResolvers<undefined>();
    const releaseHolder = Promise.withResolvers<undefined>();
    const client = {
      query: vi.fn((input: string | { text: string }) =>
        Promise.resolve({
          rows: (typeof input === 'string' ? input : input.text).includes(
            'unlock',
          )
            ? [{ unlocked: true }]
            : [],
        }),
      ),
      release: vi.fn(),
    };
    const connect = vi.fn(() => Promise.resolve(client));
    const pool = { connect, options: { max: 2 } } as unknown as Pool;
    const holder = withWorkspaceDestructiveOperationLock(
      pool,
      '4ecb44e7-9266-4f10-9557-ea93a737f901',
      undefined,
      async () => {
        holderStarted.resolve(undefined);
        await releaseHolder.promise;
      },
    );
    await holderStarted.promise;
    const controllers = [new AbortController(), new AbortController()];
    const reasons = [
      new Error('first queued abort'),
      new Error('second queued abort'),
    ];
    const canceled = controllers.map((controller, index) =>
      withWorkspaceDestructiveOperationLock(
        pool,
        `4ecb44e7-9266-4f10-9557-ea93a737f91${String(index)}`,
        controller.signal,
        () => Promise.resolve(),
      ),
    );
    const observed = canceled.map((operation, index) =>
      expect(operation).rejects.toBe(reasons[index]),
    );
    controllers.forEach((controller, index) => {
      controller.abort(reasons[index]);
    });
    await Promise.all(observed);
    const survivorWork = vi.fn(() => Promise.resolve('survived'));
    const survivor = withWorkspaceDestructiveOperationLock(
      pool,
      '4ecb44e7-9266-4f10-9557-ea93a737f999',
      undefined,
      survivorWork,
    );
    expect(connect).toHaveBeenCalledOnce();

    releaseHolder.resolve(undefined);
    await expect(Promise.all([holder, survivor])).resolves.toEqual([
      undefined,
      'survived',
    ]);
    expect(survivorWork).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('returns permit capacity after failed checkout and failed lock acquisition', async () => {
    const checkoutFailure = new Error('checkout failed');
    const lockFailure = new Error('lock failed');
    const successfulClient = {
      query: vi.fn((input: string | { text: string }) =>
        Promise.resolve({
          rows: (typeof input === 'string' ? input : input.text).includes(
            'unlock',
          )
            ? [{ unlocked: true }]
            : [],
        }),
      ),
      release: vi.fn(),
    };
    const failedLockClient = {
      query: vi.fn(() => Promise.reject(lockFailure)),
      release: vi.fn(),
    };
    const connect = vi
      .fn()
      .mockRejectedValueOnce(checkoutFailure)
      .mockResolvedValueOnce(failedLockClient)
      .mockResolvedValueOnce(successfulClient);
    const pool = { connect, options: { max: 2 } } as unknown as Pool;

    await expect(
      withWorkspaceDestructiveOperationLock(
        pool,
        '4ecb44e7-9266-4f10-9557-ea93a737f921',
        undefined,
        () => Promise.resolve(),
      ),
    ).rejects.toBe(checkoutFailure);
    await expect(
      withWorkspaceDestructiveOperationLock(
        pool,
        '4ecb44e7-9266-4f10-9557-ea93a737f922',
        undefined,
        () => Promise.resolve(),
      ),
    ).rejects.toBe(lockFailure);
    expect(failedLockClient.release).toHaveBeenCalledWith(lockFailure);
    await expect(
      withWorkspaceDestructiveOperationLock(
        pool,
        '4ecb44e7-9266-4f10-9557-ea93a737f923',
        undefined,
        () => Promise.resolve('next'),
      ),
    ).resolves.toBe('next');
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('does not enter work when abort races with a granted lock', async () => {
    const controller = new AbortController();
    const reason = new Error('abort as lock is granted');
    const work = vi.fn(() => Promise.resolve());
    const release = vi.fn();
    const query = vi.fn((input: string | { text: string }) => {
      const text = typeof input === 'string' ? input : input.text;
      if (text.includes('pg_advisory_lock')) controller.abort(reason);
      return Promise.resolve({ rows: [] });
    });
    const pool = {
      connect: vi.fn(() => Promise.resolve({ query, release })),
      options: { max: 2 },
    } as unknown as Pool;

    await expect(
      withWorkspaceDestructiveOperationLock(
        pool,
        '4ecb44e7-9266-4f10-9557-ea93a737f924',
        controller.signal,
        work,
      ),
    ).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(reason);
  });

  it('rejects promptly and releases a client delivered after pool-wait cancellation', async () => {
    const pendingClient = Promise.withResolvers<{
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    }>();
    const query = vi.fn();
    const release = vi.fn();
    const connect = vi.fn(() => pendingClient.promise);
    const pool = {
      connect,
      options: { max: 2 },
    } as unknown as Pool;
    const controller = new AbortController();
    const cancellation = new Error('cancelled while waiting for pool capacity');
    const work = vi.fn(() => Promise.resolve());
    const operation = withWorkspaceDestructiveOperationLock(
      pool,
      '4ecb44e7-9266-4f10-9557-ea93a737f8f5',
      controller.signal,
      work,
    );
    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledOnce();
    });

    controller.abort(cancellation);
    await expect(operation).rejects.toBe(cancellation);
    pendingClient.resolve({ query, release });
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledOnce();
    });

    expect(query).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it('does not run destructive work when cancellation wins during lock acquisition', async () => {
    const lockWait = Promise.withResolvers<{ rows: never[] }>();
    const work = vi.fn(() => {
      return Promise.resolve();
    });
    const query = vi.fn((input: string | { text: string }) => {
      const text = typeof input === 'string' ? input : input.text;
      if (text.includes('pg_advisory_lock')) return lockWait.promise;
      return Promise.resolve({ rows: [{ unlocked: true }] });
    });
    const release = vi.fn((error?: Error | boolean) => {
      if (error instanceof Error) lockWait.reject(error);
    });
    const pool = {
      connect: vi.fn(() => Promise.resolve({ query, release })),
      options: { max: 2 },
    } as unknown as Pool;
    const controller = new AbortController();
    const operation = withWorkspaceDestructiveOperationLock(
      pool,
      '4ecb44e7-9266-4f10-9557-ea93a737f8f5',
      controller.signal,
      work,
    );
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledOnce();
    });

    const cancellation = new Error('cancelled while waiting');
    controller.abort(cancellation);

    await expect(operation).rejects.toBe(cancellation);
    expect(work).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(cancellation);
  });

  it('preserves an operation failure after unlocking and disposes the client once', async () => {
    const primary = new Error('destructive operation failed');
    const release = vi.fn();
    const query = vi.fn((input: string | { text: string }) =>
      Promise.resolve({
        rows: (typeof input === 'string' ? input : input.text).includes(
          'unlock',
        )
          ? [{ unlocked: true }]
          : [],
      }),
    );
    const pool = {
      connect: vi.fn(() => Promise.resolve({ query, release })),
      options: { max: 2 },
    } as unknown as Pool;

    await expect(
      withWorkspaceDestructiveOperationLock(
        pool,
        '4ecb44e7-9266-4f10-9557-ea93a737f8f5',
        undefined,
        () => Promise.reject(primary),
      ),
    ).rejects.toBe(primary);
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.calls[0]?.[0]).toBe(primary);
  });

  it.each([
    ['false result', () => Promise.resolve({ rows: [{ unlocked: false }] })],
    ['missing result', () => Promise.resolve({ rows: [] })],
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercises an unknown rejection boundary
    ['primitive rejection', () => Promise.reject('unlock rejected')],
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercises an unknown rejection boundary
    ['undefined rejection', () => Promise.reject(undefined)],
  ])('disposes the client when unlock has a %s', async (_scenario, unlock) => {
    const release = vi.fn();
    const query = vi.fn((input: string | { text: string }) => {
      const text = typeof input === 'string' ? input : input.text;
      return text.includes('unlock') ? unlock() : Promise.resolve({ rows: [] });
    });
    const pool = {
      connect: vi.fn(() => Promise.resolve({ query, release })),
      options: { max: 2 },
    } as unknown as Pool;

    await expect(
      withWorkspaceDestructiveOperationLock(
        pool,
        '4ecb44e7-9266-4f10-9557-ea93a737f8f5',
        undefined,
        () => Promise.resolve(),
      ),
    ).rejects.toThrow(
      /Workspace destructive-operation lock (?:was lost|release failed)/u,
    );
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('contains hostile unlock rejection inspection and still disposes the client', async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('hostile prototype trap');
        },
      },
    );
    const release = vi.fn();
    const query = vi.fn((input: string | { text: string }) => {
      const text = typeof input === 'string' ? input : input.text;
      return text.includes('unlock')
        ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercises hostile rejection inspection
          Promise.reject(hostile)
        : Promise.resolve({ rows: [] });
    });
    const pool = {
      connect: vi.fn(() => Promise.resolve({ query, release })),
      options: { max: 2 },
    } as unknown as Pool;

    const failure = await withWorkspaceDestructiveOperationLock(
      pool,
      '4ecb44e7-9266-4f10-9557-ea93a737f8f5',
      undefined,
      () => Promise.resolve(),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(Object.getOwnPropertyDescriptor(failure, 'cause')?.value).toBe(
      hostile,
    );
    expect(release).toHaveBeenCalledOnce();
    expect(
      Object.getOwnPropertyDescriptor(release.mock.calls[0]?.[0], 'cause')
        ?.value,
    ).toBe(hostile);
  });

  it('retains operation, unlock, and synchronous release failures in order', async () => {
    const operationFailure = new Error('operation failed');
    const unlockFailure = new Error('unlock failed');
    const releaseFailure = new Error('release failed');
    const release = vi.fn(() => {
      throw releaseFailure;
    });
    const query = vi.fn((input: string | { text: string }) => {
      const text = typeof input === 'string' ? input : input.text;
      return text.includes('unlock')
        ? Promise.reject(unlockFailure)
        : Promise.resolve({ rows: [] });
    });
    const pool = {
      connect: vi.fn(() => Promise.resolve({ query, release })),
      options: { max: 2 },
    } as unknown as Pool;

    const failure = await withWorkspaceDestructiveOperationLock(
      pool,
      '4ecb44e7-9266-4f10-9557-ea93a737f8f5',
      undefined,
      () => Promise.reject(operationFailure),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      operationFailure,
      unlockFailure,
      releaseFailure,
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('returns permit capacity even when synchronous client release fails', async () => {
    const firstRelease = vi.fn(() => {
      throw new Error('first release failed');
    });
    const secondRelease = vi.fn();
    const query = vi.fn((input: string | { text: string }) =>
      Promise.resolve({
        rows: (typeof input === 'string' ? input : input.text).includes(
          'unlock',
        )
          ? [{ unlocked: true }]
          : [],
      }),
    );
    const connect = vi
      .fn()
      .mockResolvedValueOnce({ query, release: firstRelease })
      .mockResolvedValueOnce({ query, release: secondRelease });
    const pool = { connect, options: { max: 2 } } as unknown as Pool;

    await expect(
      withWorkspaceDestructiveOperationLock(
        pool,
        '4ecb44e7-9266-4f10-9557-ea93a737f8f5',
        undefined,
        () => Promise.resolve(),
      ),
    ).rejects.toThrow('first release failed');
    await expect(
      withWorkspaceDestructiveOperationLock(
        pool,
        'd4a26d4b-e7b5-49e8-ab78-203c90466dd4',
        undefined,
        () => Promise.resolve('next'),
      ),
    ).resolves.toBe('next');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(secondRelease).toHaveBeenCalledOnce();
  });
});
