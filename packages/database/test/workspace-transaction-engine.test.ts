import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { withCoordinatorReadClient } from '../src/coordinator-run-store-transactions.js';
import { withWorkspaceWriteClient } from '../src/node-attempt-run-store-transactions.js';
import { withTenantScopedClient } from '../src/workspace.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';

function result(rows: readonly Record<string, unknown>[] = []): QueryResult {
  return { rows } as unknown as QueryResult;
}

function poolWith(client: Pick<PoolClient, 'query' | 'release'>): Pool {
  return {
    connect: () => Promise.resolve(client as PoolClient),
  } as unknown as Pool;
}

describe('shared workspace transaction engine', () => {
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

  it('retains behavior-named read/write facades over the shared modes', async () => {
    const beginStatements: string[] = [];
    const makeClient = (): Pick<PoolClient, 'query' | 'release'> => {
      let transactionActive = false;
      return {
        query: vi.fn((statement: string) => {
          if (statement.startsWith('begin')) {
            beginStatements.push(statement);
            transactionActive = true;
          }
          if (statement === 'commit' || statement === 'rollback')
            transactionActive = false;
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
        }) as unknown as PoolClient['query'],
        release: vi.fn(),
      };
    };
    const signal = new AbortController().signal;

    await withCoordinatorReadClient(
      poolWith(makeClient()),
      workspaceId,
      signal,
      () => Promise.resolve(),
    );
    await withWorkspaceWriteClient(
      poolWith(makeClient()),
      workspaceId,
      signal,
      () => Promise.resolve(),
    );

    expect(beginStatements).toEqual([
      'begin isolation level repeatable read read only',
      'begin',
    ]);
  });
});
