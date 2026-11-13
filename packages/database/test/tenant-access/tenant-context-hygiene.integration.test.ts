import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  apiPool,
  backendId,
  waitForBackendAbsent,
  currentSettings,
  captureRejection,
  waitForSlowQuery,
} from './tenant-context-hygiene/fixture.js';
import { randomUUID } from 'node:crypto';
import {
  withPlatformTransaction,
  withWorkspaceScope,
  withActorDiscoveryScope,
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../../src/tenant-access/transactions.js';
import { sql } from 'drizzle-orm';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
describe('tenant-scoped transaction hygiene', () => {
  it('restores actor discovery before switching to a workspace, including application failure', async () => {
    await withPlatformTransaction(apiPool, async (client) => {
      const actorId = randomUUID();
      await withActorDiscoveryScope(client, actorId, async (scoped) => {
        expect(await currentSettings(scoped)).toEqual({
          workspaceId: null,
          actorId,
        });
        expect(
          (
            await scoped.query(
              "select current_setting('app.discovery_scope',true) scope",
            )
          ).rows,
        ).toEqual([{ scope: 'workspace_memberships' }]);
      });
      const original = new Error('Discovery failed');
      await expect(
        withActorDiscoveryScope(client, actorId, () =>
          Promise.reject(original),
        ),
      ).rejects.toBe(original);
      expect(await currentSettings(client)).toEqual({
        workspaceId: null,
        actorId: null,
      });
      await withWorkspaceScope(
        client,
        { workspaceId: randomUUID() },
        async (scoped) => {
          expect(
            (
              await scoped.query(
                "select nullif(current_setting('app.discovery_scope',true),'') scope",
              )
            ).rows,
          ).toEqual([{ scope: null }]);
        },
      );
    });
  });

  it('switches linked workspaces on one checkout while keeping their RLS fences', async () => {
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const recordA = randomUUID();
    const recordB = randomUUID();
    await withPlatformTransaction(apiPool, async (client) => {
      const backend = await backendId(client);
      await withWorkspaceScope(
        client,
        { workspaceId: workspaceA },
        async (scoped) => {
          expect(await backendId(scoped)).toBe(backend);
          await scoped.query(
            "insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref) values($1,$2,'rls.test',$3,repeat('a',64),repeat('b',64),'completed',$1,'{}')",
            [recordA, workspaceA, 'A'],
          );
        },
      );
      expect(await currentSettings(client)).toEqual({
        workspaceId: null,
        actorId: null,
      });
      await withWorkspaceScope(
        client,
        { workspaceId: workspaceB },
        async (scoped) => {
          expect(
            (await scoped.query('select id from app.idempotency_records')).rows,
          ).toEqual([]);
          await scoped.query(
            "insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref) values($1,$2,'rls.test',$3,repeat('a',64),repeat('b',64),'completed',$1,'{}')",
            [recordB, workspaceB, 'B'],
          );
        },
      );
      await withWorkspaceScope(
        client,
        { workspaceId: workspaceA },
        async (scoped) => {
          expect(
            (await scoped.query('select id from app.idempotency_records')).rows,
          ).toEqual([{ id: recordA }]);
        },
      );
      expect(
        (await client.query('select id from app.idempotency_records')).rows,
      ).toEqual([]);
      expect(await currentSettings(client)).toEqual({
        workspaceId: null,
        actorId: null,
      });
    });
  });

  it('rolls back changes across linked scopes and refuses a cross-workspace write', async () => {
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const recordA = randomUUID();
    await expect(
      withPlatformTransaction(apiPool, async (client) => {
        await withWorkspaceScope(
          client,
          { workspaceId: workspaceA },
          (scoped) =>
            scoped.query(
              "insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref) values($1,$2,'rls.test',$3,repeat('a',64),repeat('b',64),'completed',$1,'{}')",
              [recordA, workspaceA, 'rollback'],
            ),
        );
        await withWorkspaceScope(
          client,
          { workspaceId: workspaceB },
          (scoped) =>
            scoped.query(
              "insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref) values($1,$2,'rls.test',$3,repeat('a',64),repeat('b',64),'completed',$1,'{}')",
              [randomUUID(), workspaceA, 'refused'],
            ),
        );
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    await withTenantScopedClient(
      apiPool,
      { workspaceId: workspaceA },
      async (client) => {
        expect(
          (
            await client.query(
              'select id from app.idempotency_records where id=$1',
              [recordA],
            )
          ).rows,
        ).toEqual([]);
      },
    );
    expect(await currentSettings(apiPool)).toEqual({
      workspaceId: null,
      actorId: null,
    });
  });

  it('cleans a scoped application failure and rejects nested scopes before work', async () => {
    await withPlatformTransaction(apiPool, async (client) => {
      const original = new Error('scoped application failed');
      await expect(
        withWorkspaceScope(client, { workspaceId: randomUUID() }, () =>
          Promise.reject(original),
        ),
      ).rejects.toBe(original);
      expect(await currentSettings(client)).toEqual({
        workspaceId: null,
        actorId: null,
      });
      let entered = false;
      await withWorkspaceScope(
        client,
        { workspaceId: randomUUID() },
        async (scoped) => {
          await expect(
            withWorkspaceScope(scoped, { workspaceId: randomUUID() }, () => {
              entered = true;
              return Promise.resolve();
            }),
          ).rejects.toThrow('retained workspace context');
        },
      );
      expect(entered).toBe(false);
      expect(await currentSettings(client)).toEqual({
        workspaceId: null,
        actorId: null,
      });
    });
  });

  it('keeps platform-global transactions context-free on the shared hardened path', async () => {
    await expect(
      withPlatformTransaction(apiPool, async (client) =>
        currentSettings(client),
      ),
    ).resolves.toEqual({ workspaceId: null, actorId: null });
  });

  it('rolls back cleanly, preserves the original error, and keeps the client reusable', async () => {
    // PostgreSQL reverts even session-level settings when a transaction
    // aborts, so the rollback path cannot leak context the way COMMIT can.
    // The contract here is therefore: original error surfaces untouched,
    // no spurious AggregateError, and the pool client stays usable.
    const workspaceId = randomUUID();
    let rolledBackBackend: number | undefined;
    const error = await captureRejection(() =>
      withTenantScopedClient(apiPool, { workspaceId }, async (client) => {
        rolledBackBackend = await backendId(client);
        await client.query("select set_config('app.actor_id', $1, true)", [
          'hygiene-probe',
        ]);
        throw new Error('operation failed');
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('operation failed');

    const fresh = await apiPool.connect();
    try {
      await expect(currentSettings(fresh)).resolves.toEqual({
        workspaceId: null,
        actorId: null,
      });
      await expect(backendId(fresh)).resolves.toBe(rolledBackBackend);
    } finally {
      fresh.release();
    }
  });

  it('aborts an in-flight query through the wire-level cancellation seam', async () => {
    const workspaceId = randomUUID();
    const controller = new AbortController();
    let reportBackend!: (pid: number) => void;
    const backendReported = new Promise<number>((resolve) => {
      reportBackend = resolve;
    });
    const startedAt = Date.now();
    const slow = withTenantScopedClient(
      apiPool,
      { workspaceId },
      async (client) => {
        reportBackend(await backendId(client));
        await client.query('select pg_sleep(5)');
        return 'finished';
      },
      { signal: controller.signal },
    );
    void slow.catch(() => undefined);
    let entryTimer: ReturnType<typeof setTimeout> | undefined;
    const entryTimeout = new Promise<never>((_resolve, reject) => {
      entryTimer = setTimeout(() => {
        reject(
          new Error('Tenant cancellation callback did not acquire a backend'),
        );
      }, 2_000);
    });
    let canceledBackend: number;
    try {
      canceledBackend = await Promise.race([backendReported, entryTimeout]);
    } catch (error: unknown) {
      controller.abort();
      await slow.catch(() => undefined);
      throw error;
    } finally {
      if (entryTimer !== undefined) clearTimeout(entryTimer);
    }
    await waitForSlowQuery(canceledBackend);
    controller.abort();
    await expect(slow).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await waitForBackendAbsent(canceledBackend);

    const fresh = await apiPool.connect();
    try {
      await expect(currentSettings(fresh)).resolves.toEqual({
        workspaceId: null,
        actorId: null,
      });
      await expect(backendId(fresh)).resolves.not.toBe(canceledBackend);
    } finally {
      fresh.release();
    }
  });

  it('verifies and cleans both context settings on the success path', async () => {
    const workspaceId = randomUUID();
    const actorId = 'hygiene-success-probe';
    await expect(
      withTenantScopedClient(
        apiPool,
        { workspaceId, actorId },
        async (client) => currentSettings(client),
      ),
    ).resolves.toEqual({ workspaceId, actorId });
  });

  it('keeps the drizzle-backed workspace transaction working on top of the shared primitive', async () => {
    const workspaceId = randomUUID();
    await expect(
      withWorkspaceTransaction(apiPool, workspaceId, async (transaction) => {
        const result = await transaction.db.execute(
          sql`select current_setting('app.workspace_id', true) as workspace_id`,
        );
        const rows = result.rows as { workspace_id: string }[];
        return rows[0]?.workspace_id;
      }),
    ).resolves.toBe(workspaceId);
  });
});
