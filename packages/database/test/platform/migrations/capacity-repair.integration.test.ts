import { expect, it } from 'vitest';
import { seedWorkflow, withDatabase } from './upgrade-fixture.js';

it.each([
  [37, 12345, 23456],
  [3, 17, 19],
])(
  'applies instance limits %s/%s/%s to existing versions without losing usage counters',
  async (active, queued, artifacts) => {
    await withDatabase(async ({ admin }) => {
      const { workspaceId } = await seedWorkflow(admin);
      await admin.query<Record<string, unknown>>(
        'insert into app.workspace_artifact_capacity(workspace_id) values($1)',
        [workspaceId],
      );
      await admin.query<Record<string, unknown>>(
        "insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit,effective_at) values($1,2,'active',20,10000,'2026-01-01')",
        [workspaceId],
      );
      await admin.query<Record<string, unknown>>(
        'update app.workspace_artifact_capacity set charged_count=11,charged_bytes=1234 where workspace_id=$1',
        [workspaceId],
      );
      const read = async () =>
        (
          await admin.query<Record<string, unknown>>(
            `select v.version,v.active_run_limit,v.queued_run_limit,a.artifact_count_limit,a.charged_count,a.charged_bytes::text from app.workspace_execution_entitlement_versions v join app.workspace_artifact_capacity a using(workspace_id) where workspace_id=$1 order by version`,
            [workspaceId],
          )
        ).rows;
      const expected = [1, 2].map((version) => ({
        version,
        active_run_limit: active,
        queued_run_limit: queued,
        artifact_count_limit: artifacts,
        charged_count: 11,
        charged_bytes: '1234',
      }));
      await admin.query('select app.apply_instance_capacity($1,$2,$3)', [
        active,
        queued,
        artifacts,
      ]);
      expect(await read()).toEqual(expected);
      await admin.query('select app.apply_instance_capacity($1,$2,$3)', [
        active,
        queued,
        artifacts,
      ]);
      expect(await read()).toEqual(expected);
    });
  },
);
