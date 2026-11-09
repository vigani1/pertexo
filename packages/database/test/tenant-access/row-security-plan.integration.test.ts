import { expect, it } from 'vitest';
import { seedReferenceIndexOwners } from '../artifacts/reference-index.fixture.js';
import { withUpgradeDatabase } from '../platform/migrations/upgrade-fixture.js';

it('uses the ordered run-status index through the app policy after a populated upgrade', async () => {
  await withUpgradeDatabase(116, async ({ admin, upgrade }) => {
    const scopes = [
      await seedReferenceIndexOwners(admin),
      await seedReferenceIndexOwners(admin),
    ] as const;
    const client = await admin.connect();
    try {
      try {
        // Seed retained history without exercising per-insert product accounting;
        // this proof measures SELECT planning on the real indexed table.
        await client.query('set session_replication_role=replica');
        for (const scope of scopes) {
          await client.query("select set_config('app.workspace_id',$1,false)", [
            scope.workspaceId,
          ]);
          await client.query(
            `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at,completed_at,admission_ticket,execution_entitlement_version)
      select gen_random_uuid(),$1,$2,r.workflow_version_id,'manual',case when n%3=0 then 'succeeded' else 'failed' end,
        clock_timestamp()-n*interval '1 second',clock_timestamp(),nextval('app.workflow_run_admission_ticket_seq'),r.execution_entitlement_version
      from app.workflow_runs r cross join generate_series(1,15000)n where r.id=$3`,
            [scope.workspaceId, scope.workflowId, scope.runId],
          );
        }
      } finally {
        await client.query('set session_replication_role=origin');
      }
      await client.query('analyze app.workflow_runs');
      const explain = async () => {
        await client.query('begin');
        await client.query('set local role pertexo_app');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          scopes[0].workspaceId,
        ]);
        try {
          return (
            await client.query<{ 'QUERY PLAN': string }>(
              `explain (analyze,buffers) select id,created_at from app.workflow_runs where workspace_id=$1 and status='failed' order by created_at desc,id desc limit 51`,
              [scopes[0].workspaceId],
            )
          ).rows
            .map((row) => row['QUERY PLAN'])
            .join('\n');
        } finally {
          await client.query('rollback');
        }
      };
      const before = await explain();
      await upgrade();
      const after = await explain();
      console.log('dm-06 before:\n' + before + '\ndm-06 after:\n' + after);
      expect(after).toContain('workflow_runs_workspace_status_created_idx');
      expect(after).toMatch(/Index (Only )?Scan/);
      expect(after).not.toMatch(/Sort|Bitmap/);
    } finally {
      client.release();
    }
  });
}, 120_000);
