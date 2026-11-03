import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../../platform/migrations/upgrade-fixture.js';

it('repairs incomplete old pauses from retained history or fallback counts, preserves complete rows and refuses new incomplete pauses', async () => {
  await withUpgradeDatabase(81, async ({ admin, upgrade }) => {
    const {
      workspaceId,
      ownerId,
      workflowId: unpaused,
    } = await seedWorkflow(admin);
    await admin.query(
      'update app.workspaces set auto_pause_threshold=9 where id=$1',
      [workspaceId],
    );
    const cases = [
      {
        name: 'missing reason',
        reason: null,
        count: 4,
        threshold: null,
        streak: null,
        audits: [],
        expected: 4,
      },
      {
        name: 'missing count',
        reason: 'consecutive_failures',
        count: null,
        threshold: null,
        streak: 5,
        audits: [6, 8],
        expected: 8,
      },
      {
        name: 'missing both',
        reason: null,
        count: null,
        threshold: null,
        streak: null,
        audits: [7],
        expected: 7,
      },
      {
        name: 'expired audit with positive streak',
        reason: null,
        count: null,
        threshold: null,
        streak: 5,
        audits: [],
        expected: 5,
      },
      {
        name: 'expired audit with workflow threshold',
        reason: null,
        count: null,
        threshold: 11,
        streak: 0,
        audits: [],
        expected: 11,
      },
      {
        name: 'expired audit with workspace threshold',
        reason: null,
        count: null,
        threshold: null,
        streak: null,
        audits: [],
        expected: 9,
      },
      {
        name: 'complete',
        reason: 'consecutive_failures',
        count: 12,
        threshold: null,
        streak: null,
        audits: [99],
        expected: 12,
      },
    ];
    const ids: string[] = [];
    for (const scenario of cases) {
      const id = randomUUID();
      ids.push(id);
      await admin.query(
        `insert into app.workflows(id,workspace_id,name,created_by,auto_pause_threshold,
        trigger_pause_state,trigger_paused_at,trigger_pause_reason,trigger_pause_failures,trigger_pause_last_run_id,trigger_pause_revision)
        values($1,$2,$3,$4,$5,'paused','2026-10-01',$6,$7,$8,3)`,
        [
          id,
          workspaceId,
          scenario.name,
          ownerId,
          scenario.threshold,
          scenario.reason,
          scenario.count,
          randomUUID(),
        ],
      );
      if (scenario.streak !== null)
        await admin.query(
          `insert into app.workflow_failure_streaks(workspace_id,workflow_id,consecutive_failures) values($1,$2,$3)`,
          [workspaceId, id, scenario.streak],
        );
      for (const [index, failures] of scenario.audits.entries())
        await admin.query(
          `insert into app.audit_events(id,workspace_id,action,target_type,target_id,metadata,occurred_at)
        values($1,$2,'workflow.triggers_paused','workflow',$3,$4::jsonb,'2026-10-01'::timestamptz + $5 * interval '1 minute')`,
          [randomUUID(), workspaceId, id, JSON.stringify({ failures }), index],
        );
    }
    const snapshot = async () =>
      (
        await admin.query<Record<string, unknown>>(
          'select to_jsonb(w) row from app.workflows w where id=any($1::uuid[]) order by id',
          [[unpaused, ids.at(-1)]],
        )
      ).rows;
    const complete = await snapshot();
    expect(await upgrade(82)).toEqual([
      '0082_complete_trigger_pause_state.sql',
    ]);
    expect(await snapshot()).toEqual(complete);
    for (const [index, id] of ids.entries()) {
      expect(
        (
          await admin.query(
            `select trigger_pause_state,trigger_pause_reason,trigger_pause_failures,trigger_pause_revision::int,
        trigger_paused_at='2026-10-01'::timestamptz retained_time,trigger_pause_last_run_id is not null retained_run from app.workflows where id=$1`,
            [id],
          )
        ).rows,
      ).toEqual([
        {
          trigger_pause_state: 'paused',
          trigger_pause_reason: 'consecutive_failures',
          trigger_pause_failures: cases[index]?.expected,
          trigger_pause_revision: 3,
          retained_time: true,
          retained_run: true,
        },
      ]);
    }
    for (const [reason, count] of [
      [null, 3],
      ['consecutive_failures', null],
      [null, null],
    ]) {
      await expect(
        admin.query(
          'update app.workflows set trigger_pause_reason=$2,trigger_pause_failures=$3 where id=$1',
          [ids[0], reason, count],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'workflows_trigger_pause_valid',
      });
    }
    expect(await upgrade(82)).toEqual([]);
  });
});
