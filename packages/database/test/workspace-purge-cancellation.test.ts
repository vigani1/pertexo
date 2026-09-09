import type { PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createWorkspacePurgeCoordinator } from '../src/lifecycle/workspace-purge.js';

const config = {
  connectionString: 'postgresql://unused.test/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 2,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

const options = {
  externalOperationTimeoutMs: 1_000,
  leaseOwner: 'purge-cancellation-test',
  leaseSeconds: 5,
  lockTimeoutMs: 100,
  statementTimeoutMs: 1_000,
} as const;

const emptyResult = { rows: [] } as unknown as QueryResult<never>;
const ledger = {
  append: vi.fn(),
  reconcile: vi.fn(),
};
const objectStore = { purgeWorkspacePage: vi.fn() };

describe('workspace purge cancellation', () => {
  it('rejects a pre-aborted run before acquiring or querying the pool', async () => {
    const pool = {
      connect: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
      options: { max: 2 },
      query: vi.fn(),
    };
    const coordinator = createWorkspacePurgeCoordinator(
      config,
      ledger,
      objectStore,
      { ...options, pool },
    );
    const controller = new AbortController();
    const reason = new Error('already stopped');
    controller.abort(reason);

    await expect(coordinator.processNext(controller.signal)).rejects.toBe(
      reason,
    );
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('interrupts a blocked discovery query and starts no follow-on discovery', async () => {
    const blocked = Promise.withResolvers<QueryResult<never>>();
    const release = vi.fn((error?: Error) => {
      if (error !== undefined) blocked.reject(error);
    });
    const clientQuery = vi.fn((request: string | { text: string }) => {
      const text = typeof request === 'string' ? request : request.text;
      if (text.includes("current_setting('app.workspace_id'")) {
        return Promise.resolve({
          rows: [{ actor_id: null, workspace_id: null }],
        } as unknown as QueryResult<never>);
      }
      if (text.includes('find_due_workspace_purge_step'))
        return blocked.promise;
      return Promise.resolve(emptyResult);
    });
    const client = { query: clientQuery, release } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      end: vi.fn().mockResolvedValue(undefined),
      options: { max: 2 },
      query: vi.fn((text: string) =>
        text.includes('find_due_workspace_purge_step')
          ? blocked.promise
          : Promise.resolve(emptyResult),
      ),
    };
    const coordinator = createWorkspacePurgeCoordinator(
      config,
      ledger,
      objectStore,
      { ...options, pool },
    );
    const controller = new AbortController();
    const reason = new Error('stop purge discovery');
    const processing = coordinator.processNext(controller.signal);
    const rejection = expect(processing).rejects.toBe(reason);

    await vi.waitFor(() => {
      expect(
        pool.query.mock.calls.length + clientQuery.mock.calls.length,
      ).toBeGreaterThan(0);
    });
    controller.abort(reason);
    await rejection;
    expect(release).toHaveBeenCalledWith(expect.any(Error));
    expect(
      [...pool.query.mock.calls, ...clientQuery.mock.calls].filter(
        ([request]) => {
          const text = typeof request === 'string' ? request : request.text;
          return text.includes('find_due_workspace_purge_completion');
        },
      ),
    ).toHaveLength(0);
  });

  it('rejects while pool acquisition is starved and destroys a late client', async () => {
    const pendingClient = Promise.withResolvers<PoolClient>();
    const clientQuery = vi.fn().mockResolvedValue(emptyResult);
    const release = vi.fn();
    const pool = {
      connect: vi.fn(() => pendingClient.promise),
      end: vi.fn().mockResolvedValue(undefined),
      options: { max: 2 },
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspace_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        ],
      }),
    };
    const coordinator = createWorkspacePurgeCoordinator(
      config,
      ledger,
      objectStore,
      { ...options, pool },
    );
    const controller = new AbortController();
    const reason = new Error('stop pool wait');
    const processing = coordinator.processNext(controller.signal);
    const rejection = expect(processing).rejects.toBe(reason);

    await vi.waitFor(() => {
      expect(pool.connect).toHaveBeenCalledOnce();
    });
    controller.abort(reason);
    await rejection;
    pendingClient.resolve({
      query: clientQuery,
      release,
    } as unknown as PoolClient);
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledWith(expect.any(Error));
    });
    expect(clientQuery).not.toHaveBeenCalled();
  });
});
