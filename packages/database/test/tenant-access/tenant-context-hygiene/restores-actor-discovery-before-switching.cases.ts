import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  withPlatformTransaction,
  withWorkspaceScope,
  withActorDiscoveryScope,
  withTenantScopedClient,
} from '../../../src/tenant-access/transactions.js';
import {
  apiPool,
  backendId,
  waitForBackendAbsent,
  currentSettings,
  captureRejection,
} from './fixture.js';

export function registerRestoresActorDiscoveryBeforeSwitching(): void {
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
            'insert into app.rls_probe_records(id,workspace_id,label) values($1,$2,$3)',
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
            (await scoped.query('select id from app.rls_probe_records')).rows,
          ).toEqual([]);
          await scoped.query(
            'insert into app.rls_probe_records(id,workspace_id,label) values($1,$2,$3)',
            [recordB, workspaceB, 'B'],
          );
        },
      );
      await withWorkspaceScope(
        client,
        { workspaceId: workspaceA },
        async (scoped) => {
          expect(
            (await scoped.query('select id from app.rls_probe_records')).rows,
          ).toEqual([{ id: recordA }]);
        },
      );
      expect(
        (await client.query('select id from app.rls_probe_records')).rows,
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
              'insert into app.rls_probe_records(id,workspace_id,label) values($1,$2,$3)',
              [recordA, workspaceA, 'rollback'],
            ),
        );
        await withWorkspaceScope(
          client,
          { workspaceId: workspaceB },
          (scoped) =>
            scoped.query(
              'insert into app.rls_probe_records(id,workspace_id,label) values($1,$2,$3)',
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
              'select id from app.rls_probe_records where id=$1',
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

    const leakedWorkspaceId = randomUUID();
    let contaminatedBackend: number | undefined;
    const error = (await captureRejection(() =>
      withPlatformTransaction(apiPool, async (client) => {
        contaminatedBackend = await backendId(client);
        await client.query("select set_config('app.workspace_id', $1, false)", [
          leakedWorkspaceId,
        ]);
      }),
    )) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe('Platform context cleanup failed');
    expect(contaminatedBackend).toBeDefined();
    await waitForBackendAbsent(contaminatedBackend ?? -1);

    const fresh = await apiPool.connect();
    try {
      await expect(currentSettings(fresh)).resolves.toEqual({
        workspaceId: null,
        actorId: null,
      });
      await expect(backendId(fresh)).resolves.not.toBe(contaminatedBackend);
    } finally {
      fresh.release();
    }
  });
}
