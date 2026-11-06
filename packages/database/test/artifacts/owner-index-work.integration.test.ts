import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('does no derived-index extraction or replacement for reference-free bulk history', async () => {
  await withUpgradeDatabase(Number.POSITIVE_INFINITY, async ({ admin }) => {
    const { workspaceId, workflowId } = await seedWorkflow(admin);
    const client = await admin.connect();
    try {
      await client.query("set track_functions='all'");
      await client.query("select set_config('app.workspace_id',$1,false)", [
        workspaceId,
      ]);
      const runId = randomUUID();
      await client.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','succeeded')`,
        [runId, workspaceId, workflowId, randomUUID()],
      );
      await client.query(
        `select pg_stat_reset_single_function_counters(oid) from pg_proc where pronamespace='app'::regnamespace and proname in ('artifact_owner_ids','replace_artifact_owner_references','index_artifact_owner_references')`,
      );
      await client.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,completed_at) select gen_random_uuid(),$1,$2,gen_random_uuid(),'manual','succeeded',clock_timestamp() from generate_series(1,1000)`,
        [workspaceId, workflowId],
      );
      await client.query(
        `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload) select $1,$2,n,'node.progress','{"message":"no files here","artifactId":"business data"}'::jsonb from generate_series(1,1000)n`,
        [workspaceId, runId],
      );
      await client.query('select pg_stat_force_next_flush()');
      const stats = await admin.query<{ calls: string }>(
        `select coalesce(sum(calls),0)::text calls from pg_stat_user_functions where schemaname='app' and funcname in ('artifact_owner_ids','replace_artifact_owner_references','index_artifact_owner_references')`,
      );
      expect(stats.rows[0]?.calls).toBe('0');
      expect(
        (
          await client.query(
            'select count(*)::int count from app.run_events where workflow_run_id=$1',
            [runId],
          )
        ).rows,
      ).toEqual([{ count: 1000 }]);
    } finally {
      client.release();
    }
  });
}, 60_000);
