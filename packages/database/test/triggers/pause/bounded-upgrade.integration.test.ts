import { expect, it } from 'vitest';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../../platform/migrations/upgrade-fixture.js';

it('compacts a long 0089 failure ledger without changing pauses, carry or ordering fences', async () => {
  await withUpgradeDatabase(89, async ({ admin, upgrade }) => {
    const enabled = await seedWorkflow(admin);
    const disabled = await seedWorkflow(admin);
    const split = await seedWorkflow(admin);
    await admin.query(
      'update app.workflows set auto_pause_enabled=false where id=$1',
      [disabled.workflowId],
    );
    await admin.query(
      `update app.workflows set trigger_pause_state='paused',trigger_pause_reason='consecutive_failures',
      trigger_pause_failures=10,trigger_paused_at='2026-10-01',trigger_pause_last_run_id=gen_random_uuid() where id=$1`,
      [enabled.workflowId],
    );
    for (const scope of [enabled, disabled, split]) {
      await admin.query(
        `insert into app.workflow_failure_streaks(workspace_id,workflow_id,consecutive_failures,legacy_failures,resumed_after)
        values($1,$2,5007,7,'2026-09-01')`,
        [scope.workspaceId, scope.workflowId],
      );
      await admin.query(
        `insert into app.workflow_trigger_failures(id,workspace_id,workflow_id,run_id,ended_at)
        select gen_random_uuid(),$1,$2,gen_random_uuid(),'2026-10-01'::timestamptz+n*interval '1 second'
        from generate_series(1,5000) n`,
        [scope.workspaceId, scope.workflowId],
      );
    }
    await admin.query(
      `update app.workflow_failure_streaks set legacy_failures=0,
      success_ended_at='2026-10-01'::timestamptz+interval '4950.5 seconds',success_outcome_id=gen_random_uuid()
      where workflow_id=$1`,
      [split.workflowId],
    );
    const snapshot = async () =>
      (
        await admin.query<{ workflow: unknown }>(
          'select to_jsonb(w) workflow from app.workflows w order by id',
        )
      ).rows;
    const before = await snapshot();
    const newest = (
      await admin.query(
        `select id from app.workflow_trigger_failures where workflow_id=$1
      order by ended_at desc,id desc limit 100`,
        [enabled.workflowId],
      )
    ).rows;
    expect(await upgrade(90)).toEqual([
      '0090_bound_trigger_failure_evidence.sql',
    ]);
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await admin.query(
          `select id from app.workflow_trigger_failures where workflow_id=$1
      order by ended_at desc,id desc`,
          [enabled.workflowId],
        )
      ).rows,
    ).toEqual(newest);
    expect(
      (
        await admin.query(
          `select count(*)::int count from app.workflow_trigger_failures where workflow_id=$1`,
          [disabled.workflowId],
        )
      ).rows,
    ).toEqual([{ count: 100 }]);
    expect(
      (
        await admin.query(
          `select count(*)::int count from app.workflow_trigger_failures where workflow_id=$1`,
          [split.workflowId],
        )
      ).rows,
    ).toEqual([{ count: 50 }]);
    expect(
      (
        await admin.query(
          `select legacy_failures,consecutive_failures,resumed_after::text from app.workflow_failure_streaks where workflow_id=$1`,
          [enabled.workflowId],
        )
      ).rows,
    ).toEqual([
      {
        legacy_failures: 7,
        consecutive_failures: 100,
        resumed_after: '2026-09-01 00:00:00+00',
      },
    ]);
    expect(
      (
        await admin.query(
          `select legacy_failures,consecutive_failures from app.workflow_failure_streaks where workflow_id=$1`,
          [split.workflowId],
        )
      ).rows,
    ).toEqual([{ legacy_failures: 0, consecutive_failures: 50 }]);
    expect(await upgrade(90)).toEqual([]);
  });
});
