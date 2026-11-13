import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  withActorScopedClient,
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '@pertexo/database/primitives';
import { withPlatformTransaction } from '@pertexo/database/platform';
import {
  workspaceId,
  actorId,
  poolWith,
  postgresConnection,
} from './workspace-transaction-engine/fixture.js';

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

  it('installs and verifies the bounded actor discovery scope', async () => {
    const connection = postgresConnection();
    const release = vi.fn();

    await expect(
      withActorScopedClient(
        poolWith({ query: connection.query, release }),
        actorId,
        () => Promise.resolve(connection.settings()),
      ),
    ).resolves.toEqual({
      'app.workspace_id': '',
      'app.actor_id': actorId,
      'app.discovery_scope': 'workspace_memberships',
      'app.organization_id': '',
    });
    expect(connection.statements[0]).toBe(
      'begin isolation level repeatable read read only',
    );
    expect(connection.settings()).toEqual({});
    expect(release).toHaveBeenCalledWith();
  });

  it.each([
    { reported: 'no row' as const, label: 'missing verification row' },
    {
      reported: { discoveryScope: 'wrong-scope' },
      label: 'wrong discovery scope',
    },
    { reported: { actorId: 'other-actor' }, label: 'wrong actor' },
    { reported: { workspaceId: actorId }, label: 'a workspace' },
  ])(
    'fails actor context verification for $label before the operation',
    async ({ reported }) => {
      const connection = postgresConnection({ reported });
      const operation = vi.fn();
      const release = vi.fn();

      await expect(
        withActorScopedClient(
          poolWith({ query: connection.query, release }),
          actorId,
          operation,
        ),
      ).rejects.toThrow('PostgreSQL tenant context verification failed');
      expect(operation).not.toHaveBeenCalled();
      expect(connection.statements).toContain('rollback');
      expect(release).toHaveBeenCalledWith();
    },
  );

  it.each([
    {
      reported: { workspaceId: '33333333-3333-4333-8333-333333333333' },
      label: 'another workspace',
    },
    { reported: { actorId: 'wrong-actor' }, label: 'another actor' },
    { reported: { actorId: '' }, label: 'no actor' },
    {
      reported: { discoveryScope: 'workspace_memberships' },
      label: 'a discovery scope',
    },
    {
      reported: { organizationId: '44444444-4444-4444-8444-444444444444' },
      label: 'an organization',
    },
  ])(
    'fails workspace context verification for $label before the operation',
    async ({ reported }) => {
      const connection = postgresConnection({ reported });
      const operation = vi.fn();
      const release = vi.fn();

      await expect(
        withTenantScopedClient(
          poolWith({ query: connection.query, release }),
          { workspaceId, actorId: 'expected-actor' },
          operation,
        ),
      ).rejects.toThrow('PostgreSQL tenant context verification failed');
      expect(operation).not.toHaveBeenCalled();
      expect(connection.statements).toContain('rollback');
      expect(release).toHaveBeenCalledWith();
    },
  );

  it('installs and verifies workspace and actor context before committing', async () => {
    const connection = postgresConnection();
    const release = vi.fn();

    await expect(
      withTenantScopedClient(
        poolWith({ query: connection.query, release }),
        { workspaceId, actorId: 'actor-1' },
        () => Promise.resolve(connection.settings()),
      ),
    ).resolves.toEqual({
      'app.workspace_id': workspaceId,
      'app.actor_id': 'actor-1',
      'app.discovery_scope': '',
      'app.organization_id': '',
    });
    expect(connection.statements.at(-1)).toBe('commit');
    expect(connection.settings()).toEqual({});
    expect(release).toHaveBeenCalledWith();
  });

  it('installs a transaction-local statement timeout with the scope', async () => {
    const connection = postgresConnection();

    await expect(
      withTenantScopedClient(
        poolWith({ query: connection.query, release: vi.fn() }),
        { workspaceId },
        () => Promise.resolve(connection.settings()),
        { statementTimeoutMillis: 30_000 },
      ),
    ).resolves.toMatchObject({
      'app.workspace_id': workspaceId,
      statement_timeout: '30000ms',
    });
    // Scope and timeout take one round trip between BEGIN and the work.
    expect(connection.statements).toHaveLength(3);
  });

  it('fails a statement-timeout read-back mismatch before domain work', async () => {
    const connection = postgresConnection({
      reported: { statementTimeoutMillis: '1' },
    });
    const operation = vi.fn();
    const release = vi.fn();

    await expect(
      withTenantScopedClient(
        poolWith({ query: connection.query, release }),
        { workspaceId },
        operation,
        { statementTimeoutMillis: 30_000 },
      ),
    ).rejects.toThrow('PostgreSQL transaction timeout verification failed');
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith();
  });

  it('runs platform-global work without installing tenant context', async () => {
    const connection = postgresConnection();
    const release = vi.fn();

    await expect(
      withPlatformTransaction(
        poolWith({ query: connection.query, release }),
        () => Promise.resolve(connection.transactionActive),
      ),
    ).resolves.toBe(true);
    expect(
      connection.statements.some((statement) =>
        statement.includes('set_config'),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledWith();
  });

  it('bounds platform-global work by a transaction-local statement timeout', async () => {
    const connection = postgresConnection();

    await expect(
      withPlatformTransaction(
        poolWith({ query: connection.query, release: vi.fn() }),
        () => Promise.resolve(connection.settings()),
        { statementTimeoutMillis: 1_500 },
      ),
    ).resolves.toEqual({ statement_timeout: '1500ms' });
  });

  it('exposes an immutable workspace transaction with a parsed identifier', async () => {
    const connection = postgresConnection();

    await expect(
      withWorkspaceTransaction(
        poolWith({ query: connection.query, release: vi.fn() }),
        workspaceId,
        (transaction) =>
          Promise.resolve({
            frozen: Object.isFrozen(transaction),
            workspaceId: transaction.workspaceId,
          }),
      ),
    ).resolves.toEqual({ frozen: true, workspaceId });
  });

  it('destroys the client when BEGIN fails', async () => {
    const beginError = new Error('connection lost');
    const connection = postgresConnection({ fail: { begin: beginError } });
    const operation = vi.fn();
    const release = vi.fn();

    await expect(
      withTenantScopedClient(
        poolWith({ query: connection.query, release }),
        { workspaceId },
        operation,
      ),
    ).rejects.toBe(beginError);
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(true);
  });

  it('preserves operation and rollback failures and destroys the client', async () => {
    const operationError = new Error('domain write failed');
    const rollbackError = new Error('rollback failed');
    const connection = postgresConnection({
      fail: { rollback: rollbackError },
    });
    const release = vi.fn();

    const rejection = withTenantScopedClient(
      poolWith({ query: connection.query, release }),
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
    const connection = postgresConnection();
    const release = vi.fn();

    await expect(
      withTenantScopedClient(
        poolWith({ query: connection.query, release }),
        { workspaceId },
        () => Promise.reject(operationError),
      ),
    ).rejects.toBe(operationError);
    expect(connection.statements.at(-1)).toBe('rollback');
    expect(connection.settings()).toEqual({});
    expect(release).toHaveBeenCalledWith();
  });

  it('preserves a release failure after a successful commit', async () => {
    const releaseError = new Error('release failed');
    const connection = postgresConnection();

    await expect(
      withTenantScopedClient(
        poolWith({
          query: connection.query,
          release: () => {
            throw releaseError;
          },
        }),
        { workspaceId },
        () => Promise.resolve(),
      ),
    ).rejects.toBe(releaseError);
  });

  it('preserves a commit failure after successfully rolling back', async () => {
    const commitFailure = new Error('commit acknowledgement failed');
    const connection = postgresConnection({ fail: { commit: commitFailure } });
    const release = vi.fn();

    await expect(
      withTenantScopedClient(
        poolWith({ query: connection.query, release }),
        { workspaceId },
        () => Promise.resolve('domain result'),
      ),
    ).rejects.toBe(commitFailure);
    expect(connection.statements.at(-1)).toBe('rollback');
    expect(release).toHaveBeenCalledWith();
  });

  it('starts no callback or later SQL when cancellation follows context verification', async () => {
    const controller = new AbortController();
    const connection = postgresConnection({
      onStatement: (statement) => {
        if (statement === 'set_config') controller.abort();
      },
    });
    const operation = vi.fn(() => Promise.resolve());
    const release = vi.fn();

    await expect(
      withTenantScopedClient(
        poolWith({ query: connection.query, release }),
        { workspaceId },
        operation,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).not.toHaveBeenCalled();
    expect(connection.statements).not.toContain('commit');
    expect(connection.statements).not.toContain('rollback');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('starts no commit when cancellation follows callback settlement', async () => {
    const controller = new AbortController();
    const connection = postgresConnection();
    const release = vi.fn();

    await expect(
      withTenantScopedClient(
        poolWith({ query: connection.query, release }),
        { workspaceId },
        () => {
          controller.abort();
          return Promise.resolve('finished');
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(connection.statements).not.toContain('commit');
    expect(connection.statements).not.toContain('rollback');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('returns the abort error when an active operation is cancelled', async () => {
    const controller = new AbortController();
    const connection = postgresConnection();
    const release = vi.fn();

    const transaction = withTenantScopedClient(
      poolWith({ query: connection.query, release }),
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
    const connection = postgresConnection({
      fail: { rollback: new Error('rollback interrupted') },
      onStatement: (statement) => {
        if (statement === 'rollback') controller.abort();
      },
    });

    await expect(
      withTenantScopedClient(
        poolWith({ query: connection.query, release: vi.fn() }),
        { workspaceId },
        () => Promise.reject(new Error('operation interrupted')),
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
});
