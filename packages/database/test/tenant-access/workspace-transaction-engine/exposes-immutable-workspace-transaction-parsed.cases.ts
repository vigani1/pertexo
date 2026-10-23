import { expect, it, vi } from 'vitest';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../../../src/testing.js';
import { workspaceId, result, poolWith } from './fixture.js';

export function registerExposesImmutableWorkspaceTransactionParsed(): void {
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

  it('preserves a commit failure after successfully rolling back', async () => {
    const commitFailure = new Error('commit acknowledgement failed');
    let transactionActive = false;
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      if (statement === 'begin') transactionActive = true;
      if (statement === 'commit') return Promise.reject(commitFailure);
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
        () => Promise.resolve('domain result'),
      ),
    ).rejects.toBe(commitFailure);
    expect(query).toHaveBeenCalledWith('rollback');
    expect(release).toHaveBeenCalledWith();
  });
}
