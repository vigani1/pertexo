import { expect, it } from 'vitest';

import { seedWorkflow, withUpgradeDatabase } from './upgrade-fixture.js';

it.each([
  [37, 12345, 23456],
  [3, 17, 19],
])(
  'repairs a committed pre-0081 capacity race to %s/%s/%s without losing counters or historical versions',
  async (active, queued, artifacts) => {
    await withUpgradeDatabase(80, async ({ admin, upgrade }) => {
      const writer = await admin.connect();
      try {
        await writer.query('begin');
        await writer.query('select app.apply_instance_capacity($1,$2,$3)', [
          active,
          queued,
          artifacts,
        ]);
        // The old provisioning function sees the committed singleton while the settings writer is held.
        const { workspaceId } = await seedWorkflow(admin);
        await admin.query(
          'insert into app.workspace_artifact_capacity(workspace_id) values($1)',
          [workspaceId],
        );
        await writer.query('commit');
        await admin.query(
          `insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
        values($1,2,'active',20,10000,'2026-01-01')`,
          [workspaceId],
        );
        await admin.query(
          'update app.workspace_artifact_capacity set charged_count=11,charged_bytes=1234 where workspace_id=$1',
          [workspaceId],
        );
        const rows = async () =>
          (
            await admin.query(
              `select
        (select jsonb_agg(to_jsonb(v) order by version) from app.workspace_execution_entitlement_versions v where workspace_id=$1) versions,
        (select to_jsonb(c) - 'updated_at' from app.workspace_artifact_capacity c where workspace_id=$1) capacity`,
              [workspaceId],
            )
          ).rows[0];
        const before = await rows();
        expect(before.capacity.artifact_count_limit).toBe(10000);
        await upgrade(88);
        const expected = {
          versions: before.versions.map((row: Record<string, unknown>) => ({
            ...row,
            active_run_limit: active,
            queued_run_limit: queued,
          })),
          capacity: { ...before.capacity, artifact_count_limit: artifacts },
        };
        expect(await rows()).toEqual(expected);
        await admin.query('select app.apply_instance_capacity($1,$2,$3)', [
          active,
          queued,
          artifacts,
        ]);
        expect(await rows()).toEqual(expected);
        expect(await upgrade(88)).toEqual([]);
      } finally {
        await writer.query('rollback');
        writer.release();
      }
    });
  },
);
