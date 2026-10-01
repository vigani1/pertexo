import { describe, expect, it, vi } from 'vitest';

import {
  dropDisconnectedDatabase,
  type DisposableDatabaseQueryClient,
} from './disposable-database.js';

function client(
  query: DisposableDatabaseQueryClient['query'],
): DisposableDatabaseQueryClient {
  return { query };
}

describe('API disposable database cleanup', () => {
  it('allows a checkpoint-delayed DROP past one second within the original budget', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn<DisposableDatabaseQueryClient['query']>((config) =>
        config.text.startsWith('drop')
          ? new Promise((resolve) =>
              setTimeout(() => {
                resolve({ rows: [] });
              }, 2_500),
            )
          : Promise.resolve({ rows: [{ connections: 0 }] }),
      );
      const cleanup = dropDisconnectedDatabase(
        client(query),
        'pertexo_test_checkpoint',
        {
          queryTimeoutMs: 5_000,
        },
      );
      const completion = expect(cleanup).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_500);
      await completion;
      expect(query.mock.calls.map(([config]) => config.query_timeout)).toEqual([
        1_000, 10_000,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses only the remaining total budget for a stalled DROP', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn<DisposableDatabaseQueryClient['query']>((config) =>
        config.text.startsWith('drop')
          ? new Promise<never>(() => undefined)
          : new Promise((resolve) =>
              setTimeout(() => {
                resolve({ rows: [{ connections: 0 }] });
              }, 400),
            ),
      );
      const cleanup = dropDisconnectedDatabase(
        client(query),
        'private_target',
        {
          beforeDrop: () => new Promise((resolve) => setTimeout(resolve, 600)),
        },
      );
      const failure = expect(cleanup).rejects.toThrow(
        'Disposable database drop query exceeded 9000ms',
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
      expect(query.mock.calls[1]?.[0].query_timeout).toBe(9_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not dispatch DROP when the ownership recheck exhausts the deadline', async () => {
    let time = 0;
    const query = vi
      .fn<DisposableDatabaseQueryClient['query']>()
      .mockResolvedValue({ rows: [{ connections: 0 }] });
    await expect(
      dropDisconnectedDatabase(client(query), 'private_target', {
        now: () => time,
        beforeDrop: () => {
          time = 10_000;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(
      'Disposable database drop deadline expired before dispatch',
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it('rejects an expired probe deadline before dispatch instead of clamping to one millisecond', async () => {
    const now = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(10_000);
    const query = vi.fn<DisposableDatabaseQueryClient['query']>();
    await expect(
      dropDisconnectedDatabase(client(query), 'private_target', { now }),
    ).rejects.toThrow(
      'Disposable database connection_probe deadline expired before dispatch',
    );
    expect(query).not.toHaveBeenCalled();
  });
  it('rechecks approved service ownership immediately before DROP and preserves on mismatch', async () => {
    const query = vi
      .fn<DisposableDatabaseQueryClient['query']>()
      .mockResolvedValue({ rows: [{ connections: 0 }] });
    const ownershipLost = new Error('owned service identity changed');
    const beforeDrop = vi.fn().mockRejectedValue(ownershipLost);
    await expect(
      dropDisconnectedDatabase(client(query), 'pertexo_test_recheck', {
        beforeDrop,
      }),
    ).rejects.toBe(ownershipLost);
    expect(beforeDrop).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0].text).toContain('pg_stat_activity');
  });
  it('orders successful ownership recheck after disconnect observation and before DROP', async () => {
    const order: string[] = [];
    const query = vi.fn<DisposableDatabaseQueryClient['query']>((config) => {
      order.push(config.text.startsWith('drop') ? 'drop' : 'connections');
      return Promise.resolve({ rows: [{ connections: 0 }] });
    });
    await dropDisconnectedDatabase(client(query), 'pertexo_test_recheck', {
      beforeDrop: () => {
        order.push('ownership');
        return Promise.resolve();
      },
    });
    expect(order).toEqual(['connections', 'ownership', 'drop']);
  });
  it('drops the exact quoted target only after observing zero clients', async () => {
    const query = vi
      .fn<DisposableDatabaseQueryClient['query']>()
      .mockResolvedValueOnce({ rows: [{ connections: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await dropDisconnectedDatabase(client(query), 'pertexo_test_"quoted');

    expect(query.mock.calls.map(([config]) => config)).toEqual([
      {
        text: `select count(*)::int connections from pg_stat_activity
          where datname=$1 and pid<>pg_backend_pid()`,
        values: ['pertexo_test_"quoted'],
        query_timeout: 1_000,
      },
      {
        text: 'drop database if exists "pertexo_test_""quoted"',
        query_timeout: query.mock.calls[1]?.[0].query_timeout,
      },
    ]);
    expect(query.mock.calls[1]?.[0].query_timeout).toBeTypeOf('number');
  });

  it('waits while connected and never terminates a session', async () => {
    const query = vi
      .fn<DisposableDatabaseQueryClient['query']>()
      .mockResolvedValueOnce({ rows: [{ connections: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ connections: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await dropDisconnectedDatabase(client(query), 'pertexo_test_waiting');

    const statements = query.mock.calls.map(
      ([config]) => (config as { text: string }).text,
    );
    expect(statements).toEqual([
      expect.stringContaining('from pg_stat_activity'),
      'select pg_sleep(0.02)',
      expect.stringContaining('from pg_stat_activity'),
      'drop database if exists "pertexo_test_waiting"',
    ]);
    expect(statements.join('\n')).not.toContain('pg_terminate_backend');
  });

  it('rejects a missing connection count without issuing DROP', async () => {
    const query = vi
      .fn<DisposableDatabaseQueryClient['query']>()
      .mockResolvedValue({ rows: [] });

    await expect(
      dropDisconnectedDatabase(client(query), 'pertexo_test_missing_count'),
    ).rejects.toThrow('connection count is unavailable');
    expect(query).toHaveBeenCalledOnce();
  });

  it('preserves query failure identity', async () => {
    const failure = new Error('inventory query failed');
    const query = vi
      .fn<DisposableDatabaseQueryClient['query']>()
      .mockRejectedValue(failure);

    await expect(
      dropDisconnectedDatabase(client(query), 'pertexo_test_query_failure'),
    ).rejects.toBe(failure);
  });

  it('bounds a stalled query without issuing DROP or session termination', async () => {
    const query = vi.fn<DisposableDatabaseQueryClient['query']>((_config) => {
      return new Promise<never>(() => undefined);
    });

    await expect(
      dropDisconnectedDatabase(client(query), 'pertexo_test_stalled', {
        queryTimeoutMs: 5,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('query exceeded 5ms');
    expect(query).toHaveBeenCalledOnce();
    const statement = (query.mock.calls[0]?.[0] as { text: string }).text;
    expect(statement).toContain('pg_stat_activity');
    expect(statement).not.toContain('drop database');
    expect(statement).not.toContain('pg_terminate_backend');
  });

  it('honors the wall-clock deadline while clients remain', async () => {
    const query = vi.fn<DisposableDatabaseQueryClient['query']>((config) =>
      Promise.resolve(
        config.text.includes('pg_stat_activity')
          ? { rows: [{ connections: 1 }] }
          : { rows: [] },
      ),
    );
    let time = 0;

    await expect(
      dropDisconnectedDatabase(client(query), 'pertexo_test_connected', {
        now: () => {
          time += 4;
          return time;
        },
        queryTimeoutMs: 100,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('still has 1 active connection');
    const statements = query.mock.calls.map(([config]) => config.text);
    expect(statements).not.toContain(
      'drop database if exists "pertexo_test_connected"',
    );
    expect(statements.join('\n')).not.toContain('pg_terminate_backend');
  });
});
