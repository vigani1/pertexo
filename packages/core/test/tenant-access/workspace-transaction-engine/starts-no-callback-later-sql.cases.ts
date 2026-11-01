import type { Pool, PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { withTenantScopedClient } from '../../../src/testing.js';
import { workspaceId, result, poolWith } from './fixture.js';

export function registerStartsNoCallbackLaterSQL(): void {
  it('starts no callback or later SQL when cancellation follows context verification', async () => {
    const controller = new AbortController();
    let transactionActive = false;
    let contextReads = 0;
    const statements: string[] = [];
    const operation = vi.fn(() => Promise.resolve());
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      statements.push(statement);
      if (statement === 'begin') transactionActive = true;
      if (statement.includes("current_setting('app.workspace_id'")) {
        contextReads += 1;
        if (contextReads === 2) controller.abort();
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
        operation,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).not.toHaveBeenCalled();
    expect(statements).not.toContain('commit');
    expect(statements).not.toContain('rollback');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('starts no commit when cancellation follows callback settlement', async () => {
    const controller = new AbortController();
    let transactionActive = false;
    const statements: string[] = [];
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      statements.push(statement);
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

    await expect(
      withTenantScopedClient(
        poolWith({ query, release }),
        { workspaceId },
        () => {
          controller.abort();
          return Promise.resolve('finished');
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(statements).not.toContain('commit');
    expect(statements).not.toContain('rollback');
    expect(release).toHaveBeenCalledTimes(1);
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
}
