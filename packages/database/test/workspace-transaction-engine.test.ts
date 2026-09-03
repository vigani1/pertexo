import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  withPlatformTransaction,
  withTenantScopedReadClient,
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../src/testing.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';

function result(rows: readonly Record<string, unknown>[] = []): QueryResult {
  return { rows } as unknown as QueryResult;
}

function poolWith(
  client: Readonly<Record<'query' | 'release', unknown>>,
): Pool {
  return {
    connect: () => Promise.resolve(client as PoolClient),
  } as unknown as Pool;
}

describe('shared workspace transaction engine', () => {
  it.each([0, 2_147_483_648, 1.5])(
    'rejects invalid PostgreSQL statement timeout %s before checkout',
    async (statementTimeoutMillis) => {
      const connect = vi.fn();
      await expect(
        withTenantScopedClient(
          { connect } as unknown as Pool,
          { workspaceId },
          () => Promise.resolve(),
          { statementTimeoutMillis },
        ),
      ).rejects.toThrow('Invalid PostgreSQL statement timeout');
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it('uses a repeatable-read snapshot through the worker read seam', async () => {
    const statements: string[] = [];
    let transactionActive = false;
    const query = vi.fn((statement: string) => {
      statements.push(statement);
      if (statement.startsWith('begin')) transactionActive = true;
      if (statement === 'commit') transactionActive = false;
      if (statement.includes("current_setting('app.workspace_id'"))
        return Promise.resolve(
          result([
            {
              workspace_id: transactionActive ? workspaceId : null,
              actor_id: null,
            },
          ]),
        );
      return Promise.resolve(result());
    });

    await expect(
      withTenantScopedReadClient(
        poolWith({ query, release: vi.fn() }),
        { workspaceId },
        () => Promise.resolve('snapshot'),
      ),
    ).resolves.toBe('snapshot');
    expect(statements).toContain(
      'begin isolation level repeatable read read only',
    );
  });

  it('rejects and destroys a client contaminated before checkout use', async () => {
    const release = vi.fn();
    const client = {
      query: vi
        .fn()
        .mockResolvedValue(
          result([{ workspace_id: workspaceId, actor_id: null }]),
        ),
      release,
    };

    await expect(
      withTenantScopedClient(poolWith(client), { workspaceId }, vi.fn()),
    ).rejects.toMatchObject({ message: 'Tenant context cleanup failed' });
    expect(release).toHaveBeenCalledWith(true);
  });

  it('rejects and destroys a client retaining actor context before use', async () => {
    const release = vi.fn();
    const client = {
      query: vi
        .fn()
        .mockResolvedValue(
          result([{ workspace_id: null, actor_id: 'retained-actor' }]),
        ),
      release,
    };

    await expect(
      withTenantScopedClient(poolWith(client), { workspaceId }, vi.fn()),
    ).rejects.toMatchObject({ message: 'Tenant context cleanup failed' });
    expect(release).toHaveBeenCalledWith(true);
  });

  it('fails context read-back before invoking a domain query', async () => {
    const operation = vi.fn();
    const release = vi.fn();
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([{ workspace_id: null, actor_id: null }]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(
        result([
          {
            workspace_id: '22222222-2222-4222-8222-222222222222',
            actor_id: null,
          },
        ]),
      )
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{ workspace_id: null, actor_id: null }]));

    await expect(
      withTenantScopedClient(
        poolWith({ query, release }),
        { workspaceId },
        operation,
      ),
    ).rejects.toThrow('PostgreSQL tenant context verification failed');
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith();
  });

  it('fails actor context read-back before invoking a domain query', async () => {
    const operation = vi.fn();
    const release = vi.fn();
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([{ workspace_id: null, actor_id: null }]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(
        result([{ workspace_id: workspaceId, actor_id: 'wrong-actor' }]),
      )
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{ workspace_id: null, actor_id: null }]));

    await expect(
      withTenantScopedClient(
        poolWith({ query, release }),
        { workspaceId, actorId: 'expected-actor' },
        operation,
      ),
    ).rejects.toThrow('PostgreSQL tenant context verification failed');
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith();
  });

  it('installs and verifies workspace and actor context before committing', async () => {
    let transactionActive = false;
    let actorId: string | null = null;
    const release = vi.fn();
    const query = vi.fn((statement: string, values?: readonly unknown[]) => {
      if (statement === 'begin') transactionActive = true;
      if (statement.includes("set_config('app.actor_id'")) {
        actorId = String(values?.[1]);
      }
      if (statement === 'commit') transactionActive = false;
      if (statement.includes("current_setting('app.workspace_id'")) {
        return Promise.resolve(
          result([
            {
              workspace_id: transactionActive ? workspaceId : null,
              actor_id: transactionActive ? actorId : null,
            },
          ]),
        );
      }
      return Promise.resolve(result());
    });

    await expect(
      withTenantScopedClient(
        poolWith({ query, release }),
        { workspaceId, actorId: 'actor-1' },
        () => Promise.resolve('committed'),
      ),
    ).resolves.toBe('committed');
    expect(query).toHaveBeenCalledWith(
      "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
      [workspaceId, 'actor-1'],
    );
    expect(release).toHaveBeenCalledWith();
  });

  it('installs and verifies a transaction-local statement timeout', async () => {
    let transactionActive = false;
    let statementTimeoutMillis = 0;
    const release = vi.fn();
    const query = vi.fn((statement: string, values?: readonly unknown[]) => {
      if (statement === 'begin') transactionActive = true;
      if (statement.includes("set_config('statement_timeout'"))
        statementTimeoutMillis = Number.parseInt(String(values?.[0]), 10);
      if (statement === 'commit') transactionActive = false;
      if (statement.includes("current_setting('app.workspace_id'"))
        return Promise.resolve(
          result([
            {
              workspace_id: transactionActive ? workspaceId : null,
              actor_id: null,
              statement_timeout_millis: statementTimeoutMillis,
            },
          ]),
        );
      return Promise.resolve(result());
    });

    await expect(
      withTenantScopedClient(
        poolWith({ query, release }),
        { workspaceId },
        () => Promise.resolve('bounded'),
        { statementTimeoutMillis: 30_000 },
      ),
    ).resolves.toBe('bounded');
    expect(query).toHaveBeenCalledWith(
      "select set_config('statement_timeout', $1, true)",
      ['30000ms'],
    );
  });

  it('fails a statement-timeout read-back mismatch before domain work', async () => {
    let transactionActive = false;
    const operation = vi.fn();
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      if (statement === 'begin') transactionActive = true;
      if (statement === 'rollback') transactionActive = false;
      if (statement.includes("current_setting('app.workspace_id'"))
        return Promise.resolve(
          result([
            {
              workspace_id: transactionActive ? workspaceId : null,
              actor_id: null,
              statement_timeout_millis: 1,
            },
          ]),
        );
      return Promise.resolve(result());
    });

    await expect(
      withTenantScopedClient(
        poolWith({ query, release }),
        { workspaceId },
        operation,
        { statementTimeoutMillis: 30_000 },
      ),
    ).rejects.toThrow('PostgreSQL transaction timeout verification failed');
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith();
  });

  it('runs platform-global work without installing tenant context', async () => {
    let transactionActive = false;
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      if (statement === 'begin') transactionActive = true;
      if (statement === 'commit') transactionActive = false;
      if (statement.includes("current_setting('app.workspace_id'")) {
        return Promise.resolve(
          result([{ workspace_id: null, actor_id: null }]),
        );
      }
      return Promise.resolve(result());
    });

    await expect(
      withPlatformTransaction(poolWith({ query, release }), () =>
        Promise.resolve(transactionActive),
      ),
    ).resolves.toBe(true);
    expect(
      query.mock.calls.some(([statement]) => statement.includes('set_config')),
    ).toBe(false);
    expect(release).toHaveBeenCalledWith();
  });

  it('exposes an immutable workspace transaction with a parsed identifier', async () => {
    let transactionActive = false;
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      if (statement === 'begin') transactionActive = true;
      if (statement === 'commit') transactionActive = false;
      if (statement.includes("current_setting('app.workspace_id'")) {
        return Promise.resolve(
          result([
            {
              workspace_id: transactionActive ? workspaceId : null,
              actor_id: null,
            },
          ]),
        );
      }
      return Promise.resolve(result());
    });

    await expect(
      withWorkspaceTransaction(
        poolWith({ query, release }),
        workspaceId,
        (transaction) =>
          Promise.resolve({
            frozen: Object.isFrozen(transaction),
            workspaceId: transaction.workspaceId,
          }),
      ),
    ).resolves.toEqual({ frozen: true, workspaceId });
  });

  it('preserves operation and rollback failures and destroys the client', async () => {
    const operationError = new Error('domain write failed');
    const rollbackError = new Error('rollback failed');
    const release = vi.fn();
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([{ workspace_id: null, actor_id: null }]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(
        result([{ workspace_id: workspaceId, actor_id: null }]),
      )
      .mockRejectedValueOnce(rollbackError);

    const rejection = withTenantScopedClient(
      poolWith({ query, release }),
      { workspaceId },
      () => Promise.reject(operationError),
    );
    await expect(rejection).rejects.toMatchObject({
      message: 'Tenant-scoped transaction rollback failed',
      errors: [operationError, rollbackError],
    });
    expect(release).toHaveBeenCalledWith(true);
  });

  it('rolls back an operation failure and releases a clean client', async () => {
    const operationError = new Error('domain write failed');
    let transactionActive = false;
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      if (statement === 'begin') transactionActive = true;
      if (statement === 'rollback') transactionActive = false;
      if (statement.includes("current_setting('app.workspace_id'")) {
        return Promise.resolve(
          result([
            {
              workspace_id: transactionActive ? workspaceId : null,
              actor_id: null,
            },
          ]),
        );
      }
      return Promise.resolve(result());
    });

    await expect(
      withTenantScopedClient(
        poolWith({ query, release }),
        { workspaceId },
        () => Promise.reject(operationError),
      ),
    ).rejects.toBe(operationError);
    expect(query).toHaveBeenCalledWith('rollback');
    expect(release).toHaveBeenCalledWith();
  });

  it('destroys a client contaminated after commit', async () => {
    let contextReads = 0;
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      if (statement.includes("current_setting('app.workspace_id'")) {
        contextReads += 1;
        if (contextReads === 1)
          return Promise.resolve(
            result([{ workspace_id: null, actor_id: null }]),
          );
        if (contextReads === 2)
          return Promise.resolve(
            result([{ workspace_id: workspaceId, actor_id: null }]),
          );
        return Promise.resolve(
          result([{ workspace_id: null, actor_id: 'retained-actor' }]),
        );
      }
      return Promise.resolve(result());
    });

    await expect(
      withTenantScopedClient(
        poolWith({ query, release }),
        { workspaceId },
        () => Promise.resolve(),
      ),
    ).rejects.toMatchObject({ message: 'Tenant context cleanup failed' });
    expect(release).toHaveBeenCalledWith(true);
  });

  it('preserves a release failure after a successful commit', async () => {
    let transactionActive = false;
    const releaseError = new Error('release failed');
    const query = vi.fn((statement: string) => {
      if (statement === 'begin') transactionActive = true;
      if (statement === 'commit') transactionActive = false;
      if (statement.includes("current_setting('app.workspace_id'")) {
        return Promise.resolve(
          result([
            {
              workspace_id: transactionActive ? workspaceId : null,
              actor_id: null,
            },
          ]),
        );
      }
      return Promise.resolve(result());
    });

    await expect(
      withTenantScopedClient(
        poolWith({
          query,
          release: () => {
            throw releaseError;
          },
        }),
        { workspaceId },
        () => Promise.resolve(),
      ),
    ).rejects.toBe(releaseError);
  });

  it('returns the abort error when an active operation is cancelled', async () => {
    const controller = new AbortController();
    let transactionActive = false;
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      if (statement === 'begin') transactionActive = true;
      if (statement.includes("current_setting('app.workspace_id'")) {
        return Promise.resolve(
          result([
            {
              workspace_id: transactionActive ? workspaceId : null,
              actor_id: null,
            },
          ]),
        );
      }
      return Promise.resolve(result());
    });

    const transaction = withTenantScopedClient(
      poolWith({ query, release }),
      { workspaceId },
      () => {
        controller.abort();
        return Promise.reject(new Error('query interrupted'));
      },
      { signal: controller.signal },
    );

    await expect(transaction).rejects.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });

  it('returns the abort error when cancellation interrupts rollback', async () => {
    const controller = new AbortController();
    let transactionActive = false;
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      if (statement === 'begin') transactionActive = true;
      if (statement === 'rollback') {
        controller.abort();
        return Promise.reject(new Error('rollback interrupted'));
      }
      if (statement.includes("current_setting('app.workspace_id'")) {
        return Promise.resolve(
          result([
            {
              workspace_id: transactionActive ? workspaceId : null,
              actor_id: null,
            },
          ]),
        );
      }
      return Promise.resolve(result());
    });

    await expect(
      withTenantScopedClient(
        poolWith({ query, release }),
        { workspaceId },
        () => Promise.reject(new Error('operation interrupted')),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns the abort error when cancellation interrupts context cleanup', async () => {
    const controller = new AbortController();
    let contextReads = 0;
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      if (statement.includes("current_setting('app.workspace_id'")) {
        contextReads += 1;
        if (contextReads === 1)
          return Promise.resolve(
            result([{ workspace_id: null, actor_id: null }]),
          );
        if (contextReads === 2)
          return Promise.resolve(
            result([{ workspace_id: workspaceId, actor_id: null }]),
          );
        controller.abort();
        return Promise.reject(new Error('cleanup interrupted'));
      }
      return Promise.resolve(result());
    });

    await expect(
      withTenantScopedClient(
        poolWith({ query, release }),
        { workspaceId },
        () => Promise.reject(new Error('operation failed')),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels acquisition and destroys a client that arrives after abort', async () => {
    let resolveConnection: ((client: PoolClient) => void) | undefined;
    const connection = new Promise<PoolClient>((resolve) => {
      resolveConnection = resolve;
    });
    const release = vi.fn();
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

    resolveConnection?.({ release } as unknown as PoolClient);
    await connection;
    await Promise.resolve();
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
});
