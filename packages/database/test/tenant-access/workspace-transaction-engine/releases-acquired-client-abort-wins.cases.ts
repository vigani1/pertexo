import type { Pool, PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { withTenantScopedClient } from '../../../src/testing.js';
import { workspaceId } from './fixture.js';

export function registerReleasesAcquiredClientAbortWins(): void {
  it('releases an acquired client when abort wins before transaction setup', async () => {
    let resolveConnection: ((client: PoolClient) => void) | undefined;
    const connection = new Promise<PoolClient>((resolve) => {
      resolveConnection = resolve;
    });
    const query = vi.fn();
    const release = vi.fn();
    const operation = vi.fn(() => Promise.resolve());
    const controller = new AbortController();
    const transaction = withTenantScopedClient(
      { connect: () => connection } as unknown as Pool,
      { workspaceId },
      operation,
      { signal: controller.signal },
    );

    resolveConnection?.({ query, release } as unknown as PoolClient);
    queueMicrotask(() => {
      controller.abort();
    });

    await expect(transaction).rejects.toMatchObject({ name: 'AbortError' });
    expect(query).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });

  it('closes the synchronous abort window opened while acquiring a client', async () => {
    const query = vi.fn();
    const release = vi.fn();
    const operation = vi.fn(() => Promise.resolve());
    const controller = new AbortController();
    const client = { query, release } as unknown as PoolClient;
    const connect = vi.fn(() => {
      controller.abort();
      return Promise.resolve(client);
    });

    await expect(
      withTenantScopedClient(
        { connect } as unknown as Pool,
        { workspaceId },
        operation,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();

    expect(query).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });

  it('does not acquire a client for an already-aborted transaction', async () => {
    const controller = new AbortController();
    controller.abort();
    const connect = vi.fn();

    await expect(
      withTenantScopedClient(
        { connect } as unknown as Pool,
        { workspaceId },
        () => Promise.resolve(),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('preserves a connection failure while an abort signal is active', async () => {
    const connectionError = new Error('pool unavailable');
    const pool = {
      connect: () => Promise.reject(connectionError),
    } as unknown as Pool;

    await expect(
      withTenantScopedClient(pool, { workspaceId }, () => Promise.resolve(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(connectionError);
  });

  it('absorbs a late connection rejection after cancellation', async () => {
    let rejectConnection: ((error: Error) => void) | undefined;
    const connection = new Promise<PoolClient>((_resolve, reject) => {
      rejectConnection = reject;
    });
    const pool = { connect: () => connection } as unknown as Pool;
    const controller = new AbortController();

    const transaction = withTenantScopedClient(
      pool,
      { workspaceId },
      () => Promise.resolve(),
      { signal: controller.signal },
    );
    controller.abort();
    await expect(transaction).rejects.toMatchObject({ name: 'AbortError' });

    rejectConnection?.(new Error('late pool failure'));
    await expect(connection).rejects.toThrow('late pool failure');
  });
}
