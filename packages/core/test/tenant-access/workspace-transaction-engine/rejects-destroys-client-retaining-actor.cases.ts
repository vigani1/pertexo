import { expect, it, vi } from 'vitest';
import {
  withPlatformTransaction,
  withTenantScopedClient,
} from '../../../src/testing.js';
import { workspaceId, result, poolWith } from './fixture.js';

export function registerRejectsDestroysClientRetainingActor(): void {
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
}
