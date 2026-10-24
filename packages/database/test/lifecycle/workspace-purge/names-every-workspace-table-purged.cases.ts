import { Client } from 'pg';
import { expect, it } from 'vitest';

import {
  PURGE_PRESERVED_TABLES,
  PURGE_STEPS,
} from '../../../src/lifecycle/purge/repository.js';

import {
  makeWorkspaceDueForPurge,
  purgeWorkspace,
} from '../../support/workspace-purge.js';
import {
  databaseName,
  adminUrl,
  maintenanceUrl,
  owner,
  PausingObjectStore,
  createWorkspace,
  coordinator,
} from './fixture.js';

export function registerNamesEveryWorkspaceTablePurged(): void {
  it('names every workspace table as purged or kept', async () => {
    if (owner === undefined) throw new Error('Owner pool unavailable');
    const tables = await owner.query<{ name: string }>(
      `select distinct table_class.relname as name
       from pg_attribute attribute
       join pg_class table_class on table_class.oid = attribute.attrelid
       join pg_namespace namespace on namespace.oid = table_class.relnamespace
       where namespace.nspname = 'app' and table_class.relkind = 'r'
         and attribute.attname = 'workspace_id' and not attribute.attisdropped
       order by 1`,
    );
    const covered = new Set([
      ...PURGE_STEPS.map(({ name }) => name),
      ...PURGE_PRESERVED_TABLES,
    ]);
    expect(
      tables.rows.map(({ name }) => name).filter((name) => !covered.has(name)),
    ).toEqual([]);
  });

  it('waits for the recovery period before purging', async () => {
    const workspaceId = await createWorkspace();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(
        `update app.workspaces
         set status='pending_deletion', deletion_requested_at=clock_timestamp(),
             deletion_requested_by=created_by, deletion_reason='Not yet',
             purge_after=clock_timestamp()+interval '1 day'
         where id=$1`,
        [workspaceId],
      );
    } finally {
      await admin.end();
    }
    const purge = coordinator();
    try {
      for (let call = 0; call < 5; call += 1) {
        const result = await purge.processNext();
        expect(
          result.status === 'idle' || result.workspaceId !== workspaceId,
        ).toBe(true);
      }
    } finally {
      await purge.close();
    }
  });

  it('starts one purge when workers race', async () => {
    const workspaceId = await createWorkspace();
    await makeWorkspaceDueForPurge(adminUrl, workspaceId);
    const workers = [coordinator(), coordinator(), coordinator()];
    try {
      const results = await Promise.all(
        workers.map((worker) => worker.processNext()),
      );
      expect(
        results.filter(
          (result) =>
            result.status === 'started' && result.workspaceId === workspaceId,
        ),
      ).toHaveLength(1);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
    await purgeWorkspace({ adminUrl, maintenanceUrl, workspaceId });
  });

  it('holds no transaction or workspace lock while objects are erased', async () => {
    const workspaceId = await createWorkspace();
    await makeWorkspaceDueForPurge(adminUrl, workspaceId);
    const objectStore = new PausingObjectStore();
    const purge = coordinator(objectStore);
    try {
      let reachedObjects: Promise<unknown> | undefined;
      for (let call = 0; call < 50 && reachedObjects === undefined; call += 1) {
        const next = purge.processNext();
        const outcome = await Promise.race([
          next,
          objectStore.started.promise.then(() => 'objects' as const),
        ]);
        if (outcome === 'objects') reachedObjects = next;
      }
      expect(reachedObjects).toBeDefined();
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        const activity = await admin.query<{ count: string }>(
          `select count(*)::text count from pg_stat_activity
           where datname=$1 and usename='pertexo_maintenance'
             and xact_start is not null`,
          [databaseName],
        );
        expect(activity.rows[0]?.count).toBe('0');
        await admin.query('begin');
        await expect(
          admin.query(
            'select 1 from app.workspaces where id=$1 for update nowait',
            [workspaceId],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });
        await admin.query('rollback');
      } finally {
        await admin.end();
        objectStore.resume.resolve(undefined);
      }
      await expect(reachedObjects).resolves.toMatchObject({
        status: 'completed',
        workspaceId,
      });
    } finally {
      objectStore.resume.resolve(undefined);
      await purge.close();
    }
  });
  it('refuses a tombstone while an unlisted workspace table still holds rows', async () => {
    const workspaceId = await createWorkspace();
    await makeWorkspaceDueForPurge(adminUrl, workspaceId);
    const purge = coordinator();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(
        'create table app.purge_guard_probe (workspace_id uuid not null)',
      );
      await admin.query(
        'grant select on app.purge_guard_probe to pertexo_maintenance',
      );
      await admin.query(
        'insert into app.purge_guard_probe(workspace_id) values($1)',
        [workspaceId],
      );
      const finish = async () => {
        for (let call = 0; call < 100; call += 1) {
          const result = await purge.processNext();
          if (
            result.status === 'completed' &&
            result.workspaceId === workspaceId
          )
            return;
        }
        throw new Error('Purge did not reach its completion proof');
      };
      await expect(finish()).rejects.toThrow(
        'Workspace purge left rows in purge_guard_probe',
      );
      const stored = await admin.query(
        'select status from app.workspaces where id=$1',
        [workspaceId],
      );
      expect(stored.rows).toEqual([{ status: 'purging' }]);
    } finally {
      try {
        await admin.query('drop table if exists app.purge_guard_probe');
      } finally {
        await Promise.all([admin.end(), purge.close()]);
      }
      await purgeWorkspace({ adminUrl, maintenanceUrl, workspaceId });
    }
  });
}
