import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../../platform/migrations/upgrade-fixture.js';

it('carries old streaks and pending outcomes through 0086 and 0088 without changing pause evidence or inventing history', async () => {
  await withUpgradeDatabase(84, async ({ admin, upgrade }) => {
    const { workspaceId, workflowId } = await seedWorkflow(admin);
    const lastRunId = randomUUID();
    await admin.query(
      `insert into app.workflow_failure_streaks
      (workspace_id,workflow_id,consecutive_failures,last_run_id,last_ended_at,resumed_after)
      values($1,$2,7,$3,'2026-10-02 12:00:00.123456+00','2026-10-01 12:00:00.123456+00')`,
      [workspaceId, workflowId, lastRunId],
    );
    await admin.query(
      `update app.workflows set trigger_pause_state='paused',trigger_pause_reason='consecutive_failures',
      trigger_pause_failures=7,trigger_paused_at='2026-10-02',trigger_pause_last_run_id=$2,trigger_pause_revision=4 where id=$1`,
      [workflowId, lastRunId],
    );
    const pendingRun = randomUUID();
    await admin.query(
      `with tenant as (select set_config('app.workspace_id',$2::text,true))
      insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
      select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'schedule','succeeded' from tenant`,
      [pendingRun, workspaceId, workflowId, randomUUID()],
    );
    await admin.query(
      `insert into app.workflow_trigger_outcomes(id,workspace_id,workflow_id,run_id,counts_as_failure,ended_at)
      values($1,$2,$3,$4,false,'2026-10-03 00:00:00.123456+00')`,
      [randomUUID(), workspaceId, workflowId, pendingRun],
    );
    const snapshot = async () =>
      (
        await admin.query<{
          workflow: unknown;
          streak: Record<string, unknown>;
          pending: unknown;
        }>(
          `select
      (select to_jsonb(w) from app.workflows w where id=$1) workflow,
      (select to_jsonb(s) from app.workflow_failure_streaks s where workflow_id=$1) streak,
      (select jsonb_agg(to_jsonb(o)) from app.workflow_trigger_outcomes o where workflow_id=$1) pending`,
          [workflowId],
        )
      ).rows[0];
    const before = await snapshot();
    if (before === undefined) throw new Error('Upgrade state missing');
    await upgrade(88);
    const after = await snapshot();
    expect(after).toEqual({
      ...before,
      streak: {
        ...before.streak,
        legacy_failures: 7,
        success_ended_at: null,
        success_outcome_id: null,
      },
    });
    expect(
      (await admin.query('select * from app.workflow_trigger_failures')).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query(
          "select to_regprocedure('app.fold_workflow_trigger_outcomes(integer)') old_fold",
        )
      ).rows,
    ).toEqual([{ old_fold: null }]);
    expect(await upgrade(88)).toEqual([]);
  });
});
