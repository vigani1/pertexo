import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import {
  withActorScopedClient,
  withTenantScopedReadClient,
  withTenantScopedClient,
  withWorkspaceReadTransaction,
} from '../../../src/testing.js';
import { workspaceId, actorId, result, poolWith } from './fixture.js';

export function registerRejectsInvalidPostgreSQLStatementTimeout(): void {
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

  it('installs and verifies the bounded actor discovery scope', async () => {
    const statements: string[] = [];
    let transactionActive = false;
    let activeActorId: string | null = null;
    let discoveryScope: string | null = null;
    const release = vi.fn();
    const query = vi.fn((statement: string, values?: readonly unknown[]) => {
      statements.push(statement);
      if (statement.startsWith('begin')) transactionActive = true;
      if (statement.includes("set_config('app.actor_id'")) {
        activeActorId = String(values?.[0]);
        discoveryScope = String(values?.[1]);
      }
      if (statement === 'commit') transactionActive = false;
      if (statement.includes("current_setting('app.workspace_id'"))
        return Promise.resolve(
          result([
            {
              workspace_id: null,
              actor_id: transactionActive ? activeActorId : null,
              discovery_scope: transactionActive ? discoveryScope : null,
              statement_timeout_millis: 0,
            },
          ]),
        );
      return Promise.resolve(result());
    });

    await expect(
      withActorScopedClient(poolWith({ query, release }), actorId, () =>
        Promise.resolve('members'),
      ),
    ).resolves.toBe('members');
    expect(statements).toContain(
      'begin isolation level repeatable read read only',
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("set_config('app.discovery_scope', $2, true)"),
      [actorId, 'workspace_memberships'],
    );
    expect(release).toHaveBeenCalledWith();
  });

  it('rejects a client retaining discovery context before actor work', async () => {
    const release = vi.fn();
    const operation = vi.fn();
    const query = vi.fn().mockResolvedValue(
      result([
        {
          workspace_id: null,
          actor_id: null,
          discovery_scope: 'workspace_memberships',
        },
      ]),
    );

    await expect(
      withActorScopedClient(poolWith({ query, release }), actorId, operation),
    ).rejects.toMatchObject({ message: 'Actor context cleanup failed' });
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(true);
  });

  it.each([
    { rows: [], label: 'missing verification row' },
    {
      rows: [
        {
          workspace_id: '',
          actor_id: actorId,
          discovery_scope: 'wrong-scope',
          statement_timeout_millis: 0,
        },
      ],
      label: 'wrong discovery scope',
    },
  ])('fails actor context verification for $label', async ({ rows }) => {
    let contextReads = 0;
    const operation = vi.fn();
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      if (statement.includes("current_setting('app.workspace_id'")) {
        contextReads += 1;
        if (contextReads === 1 || contextReads === 3)
          return Promise.resolve(
            result([
              {
                workspace_id: null,
                actor_id: null,
                discovery_scope: null,
              },
            ]),
          );
        return Promise.resolve(result(rows));
      }
      return Promise.resolve(result());
    });

    await expect(
      withActorScopedClient(poolWith({ query, release }), actorId, operation),
    ).rejects.toThrow('PostgreSQL tenant context verification failed');
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith();
  });

  it('adapts a workspace read transaction onto the repeatable-read owner', async () => {
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
      withWorkspaceReadTransaction(
        poolWith({ query, release: vi.fn() }),
        workspaceId,
        (transaction) => Promise.resolve(transaction.workspaceId),
      ),
    ).resolves.toBe(workspaceId);
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
}
