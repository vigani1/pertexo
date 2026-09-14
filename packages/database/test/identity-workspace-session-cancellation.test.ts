import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createIdentityWorkspaceSessionStore } from '../src/tenant-access/identity-workspace-session-store.js';

const digest = 'a'.repeat(64);

function result(rows: readonly Record<string, unknown>[] = []): QueryResult {
  return { rows } as unknown as QueryResult;
}

function sessionRow() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: '22222222-2222-4222-8222-222222222222',
    token_digest: digest,
    expires_at: new Date('2099-01-01T00:00:00.000Z'),
    revoked_at: null,
    user_agent: null,
    ip_address: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('identity session lookup cancellation', () => {
  it('does no checkout for an already-aborted lookup', async () => {
    const connect = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const store = createIdentityWorkspaceSessionStore({
      connect,
    } as unknown as Pool);

    await expect(
      store.findActiveSessionByDigest(digest, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns promptly on queued-checkout abort and disposes the late client', async () => {
    const checkout = Promise.withResolvers<PoolClient>();
    const release = vi.fn();
    const query = vi.fn();
    const controller = new AbortController();
    const store = createIdentityWorkspaceSessionStore({
      connect: () => checkout.promise,
    } as unknown as Pool);
    const lookup = store.findActiveSessionByDigest(digest, {
      signal: controller.signal,
    });

    controller.abort();
    await expect(lookup).rejects.toMatchObject({ name: 'AbortError' });
    checkout.resolve({ query, release } as unknown as PoolClient);
    await checkout.promise;
    await Promise.resolve();

    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });

  it('destroys the checked-out client when abort interrupts the session query', async () => {
    const queryStarted = Promise.withResolvers<undefined>();
    let rejectQuery: ((error: Error) => void) | undefined;
    const pendingQuery = new Promise<QueryResult>((_resolve, reject) => {
      rejectQuery = reject;
    });
    const release = vi.fn();
    const destroy = vi.fn(() => {
      rejectQuery?.(new Error('socket destroyed'));
    });
    const query = vi.fn((statement: string) => {
      if (statement.includes("current_setting('app.workspace_id'"))
        return Promise.resolve(
          result([{ workspace_id: null, actor_id: null }]),
        );
      if (statement === 'begin') return Promise.resolve(result());
      queryStarted.resolve(undefined);
      return pendingQuery;
    });
    const client = {
      query,
      release,
      connection: { stream: { destroy } },
    } as unknown as PoolClient;
    const controller = new AbortController();
    const store = createIdentityWorkspaceSessionStore({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);
    const lookup = store.findActiveSessionByDigest(digest, {
      signal: controller.signal,
    });

    await queryStarted.promise;
    controller.abort();

    await expect(lookup).rejects.toMatchObject({ name: 'AbortError' });
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });

  it.each([
    ['success', [sessionRow()]],
    ['null', []],
  ] as const)(
    'releases once and removes listeners after normal %s',
    async (_label, rows) => {
      let transactionOpen = false;
      const release = vi.fn();
      const query = vi.fn((statement: string) => {
        if (statement === 'begin') transactionOpen = true;
        if (statement === 'commit') transactionOpen = false;
        if (statement.includes("current_setting('app.workspace_id'"))
          return Promise.resolve(
            result([{ workspace_id: null, actor_id: null }]),
          );
        if (statement.includes('from app.sessions'))
          return Promise.resolve(result(rows));
        return Promise.resolve(result());
      });
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const store = createIdentityWorkspaceSessionStore({
        connect: () =>
          Promise.resolve({ query, release } as unknown as PoolClient),
      } as unknown as Pool);

      const found = await store.findActiveSessionByDigest(digest, {
        signal: controller.signal,
      });

      expect(found === null ? null : found.id).toBe(
        rows.length === 0 ? null : sessionRow().id,
      );
      expect(transactionOpen).toBe(false);
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith();
      expect(add.mock.calls.length).toBe(remove.mock.calls.length);
    },
  );
});
