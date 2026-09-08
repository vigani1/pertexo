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
});
