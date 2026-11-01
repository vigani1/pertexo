import { expect, it } from 'vitest';

import {
  randomUUID,
  retention,
  runIds,
  workspaceId,
} from '../retention.support.js';
import {
  DAY,
  daysAgo,
  inline,
  admin,
  enforceUntilIdle,
  insertRun,
  insertExecutionDetail,
  count,
  runRow,
  insertScheduleTrigger,
  insertOccurrence,
} from './fixture.js';

export function registerRemovesSignProofRowsDay(): void {
  it('removes sign-in proof rows a day after expiry, retaining recent and live journeys', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      let created;
      if (index === 0) {
        created = daysAgo(3);
      } else {
        if (index === 1) {
          created = daysAgo(0.1);
        } else {
          created = new Date();
        }
      }
      let expires;
      if (index === 0) {
        expires = daysAgo(2);
      } else {
        if (index === 1) {
          expires = daysAgo(0.05);
        } else {
          expires = new Date(Date.now() + 300_000);
        }
      }
      await admin.query(
        `insert into app.auth_sign_in_attempts
        (id,provider,state_digest,browser_digest,return_path,created_at,expires_at)
        values($1,'google',$2,$3,'/workspaces',$4,$5)`,
        [
          id,
          Buffer.alloc(32, index + 1),
          Buffer.alloc(32, 9),
          created,
          expires,
        ],
      );
    }
    const result = await retention.enforce();
    expect(result.removed.auth_sign_in_attempts).toBe(1);
    const rows = await admin.query<{ id: string }>(
      'select id from app.auth_sign_in_attempts where id=any($1::uuid[])',
      [ids],
    );
    expect(rows.rows.map((row) => row.id).sort()).toEqual(ids.slice(1).sort());
  });

  it('clears expired terminal input while retaining an expired live run input', async () => {
    await admin.query(
      "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp() where id=any($1::uuid[])",
      [runIds],
    );
    const pending = randomUUID();
    await admin.query(
      `insert into app.workflow_runs
        (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
         input_ref,input_ref_expires_at,created_at)
       values($1,$2,$3,$4,'manual','queued',$5::jsonb,$6,$6::timestamptz-interval '30 days')`,
      [
        pending,
        workspaceId,
        randomUUID(),
        randomUUID(),
        inline('kept'),
        new Date(Date.now() - DAY),
      ],
    );

    // Pages of two: the four expired fixture inputs take two passes.
    const first = await retention.enforce();
    expect(first.removed.run_inputs).toBe(2);
    expect(first.more).toBe(true);
    await enforceUntilIdle();

    const inputs = await admin.query<{ id: string; input_ref: unknown }>(
      'select id,input_ref from app.workflow_runs where id = any($1::uuid[])',
      [[...runIds, pending]],
    );
    expect(
      Object.fromEntries(inputs.rows.map((row) => [row.id, row.input_ref])),
    ).toEqual({
      ...Object.fromEntries(runIds.map((id) => [id, null])),
      [pending]: { kind: 'inline', value: 'kept' },
    });
  });

  it('purges execution details 30 days after completion and keeps the summary', async () => {
    const old = await insertRun({ completedDaysAgo: 40 });
    const recent = await insertRun({ completedDaysAgo: 10 });
    await insertExecutionDetail(old);
    await insertExecutionDetail(recent);

    await enforceUntilIdle();

    expect(await count('node_runs', old)).toBe(0);
    expect(await count('run_events', old)).toBe(0);
    expect(await runRow(old)).toMatchObject({
      output_ref: null,
      error_summary: null,
      details_purged_at: expect.any(Date) as unknown,
    });
    expect(await count('node_runs', recent)).toBe(1);
    expect(await count('run_events', recent)).toBe(1);
    expect(await runRow(recent)).toMatchObject({
      error_summary: 'failure detail',
      details_purged_at: null,
    });
  });

  it('deletes run summaries after 90 days once nothing refers to them', async () => {
    const triggerId = await insertScheduleTrigger();
    const unreferenced = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
    });
    const replaySource = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
    });
    const replayChild = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
      replaySourceRunId: replaySource,
    });
    const scheduled = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
    });
    const recentOccurrence = await insertOccurrence(triggerId, 10, scheduled);
    const tooRecent = await insertRun({
      completedDaysAgo: 80,
      detailsPurged: true,
    });

    await enforceUntilIdle();

    const remaining = await admin.query<{ id: string }>(
      'select id from app.workflow_runs where id = any($1::uuid[])',
      [[unreferenced, replaySource, replayChild, scheduled, tooRecent]],
    );
    // The replay child goes first, then its source on a later page.
    expect(remaining.rows.map(({ id }) => id).sort()).toEqual(
      [scheduled, tooRecent].sort(),
    );
    const occurrences = await admin.query(
      'select 1 from app.trigger_schedule_occurrences where id=$1',
      [recentOccurrence],
    );
    expect(occurrences.rowCount).toBe(1);
  });

  it('deletes schedule occurrences after 90 days and audit records after a year', async () => {
    const triggerId = await insertScheduleTrigger();
    const oldOccurrence = await insertOccurrence(triggerId, 100);
    const recentOccurrence = await insertOccurrence(triggerId, 30);
    const oldAudit = randomUUID();
    const recentAudit = randomUUID();
    for (const [id, days] of [
      [oldAudit, 400],
      [recentAudit, 300],
    ] as const)
      await admin.query(
        `insert into app.audit_events(id,workspace_id,action,target_type,occurred_at)
         values($1,$2,'retention.test','workspace',$3)`,
        [id, workspaceId, daysAgo(days)],
      );

    await enforceUntilIdle();

    const occurrences = await admin.query<{ id: string }>(
      'select id from app.trigger_schedule_occurrences where id = any($1::uuid[])',
      [[oldOccurrence, recentOccurrence]],
    );
    expect(occurrences.rows.map(({ id }) => id)).toEqual([recentOccurrence]);
    const audit = await admin.query<{ id: string }>(
      'select id from app.audit_events where id = any($1::uuid[])',
      [[oldAudit, recentAudit]],
    );
    expect(audit.rows.map(({ id }) => id)).toEqual([recentAudit]);
  });
}
