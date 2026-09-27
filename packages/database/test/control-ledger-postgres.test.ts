import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  acquirePoolClient,
  type MaintenancePool,
  withOwnedPoolClient,
} from '../src/lifecycle/control-ledger-postgres.js';

describe('control-ledger PostgreSQL ownership', () => {
  it('preserves a pre-aborted non-Error reason without checking out a client', async () => {
    const controller = new AbortController();
    const reason = { kind: 'review-stop' };
    controller.abort(reason);
    const connect = vi.fn();
    const pool: MaintenancePool = {
      options: { max: 1 },
      connect,
      end: () => Promise.resolve(),
    };

    await expect(acquirePoolClient(pool, controller.signal)).rejects.toBe(
      reason,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('preserves a queued non-Error reason and releases the late client', async () => {
    const controller = new AbortController();
    const reason = { kind: 'review-stop' };
    const checkout = Promise.withResolvers<PoolClient>();
    const release = vi.fn();
    const pool: MaintenancePool = {
      options: { max: 1 },
      connect: () => checkout.promise,
      end: () => Promise.resolve(),
    };
    const acquiring = acquirePoolClient(pool, controller.signal);

    controller.abort(reason);
    await expect(acquiring).rejects.toBe(reason);
    checkout.resolve({ release } as unknown as PoolClient);
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
  });

  it('destroys a checked-out client when cancellation interrupts SQL', async () => {
    const controller = new AbortController();
    const reason = new Error('stop restore inventory');
    let rejectQuery: ((error: unknown) => void) | undefined;
    const query = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectQuery = reject;
        }),
    );
    const release = vi.fn((error?: Error | boolean) => {
      if (error instanceof Error) rejectQuery?.(error);
    });
    const client = { query, release } as unknown as PoolClient;
    const pool: MaintenancePool = {
      options: { max: 1 },
      connect: () => Promise.resolve(client),
      end: () => Promise.resolve(),
    };
    const pending = withOwnedPoolClient(pool, controller.signal, (owned) =>
      owned.query('select pg_sleep(30)'),
    );
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledOnce();
    });

    controller.abort(reason);

    await expect(outcome).resolves.toBe(reason);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(reason);
  });

  it('returns a successful read client cleanly exactly once', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn(() => Promise.resolve({ rows: [{ value: 1 }] })),
      release,
    } as unknown as PoolClient;
    const pool: MaintenancePool = {
      options: { max: 1 },
      connect: () => Promise.resolve(client),
      end: () => Promise.resolve(),
    };

    await expect(
      withOwnedPoolClient(pool, undefined, async (owned) =>
        (await owned.query<{ value: number }>('select 1 value')).rows.at(0),
      ),
    ).resolves.toEqual({ value: 1 });
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
  });
});
