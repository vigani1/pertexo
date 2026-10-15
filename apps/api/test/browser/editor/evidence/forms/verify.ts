import type { Pool } from 'pg';
import { expect } from 'vitest';
export async function verifyFormEvidence(database: Pool) {
  const runs = await database.query(
    `select run.started_by,run.input_ref,node.output_ref from app.workflow_runs run join app.node_runs node on node.workspace_id=run.workspace_id and node.workflow_run_id=run.id and node.node_id='finish' where run.trigger_type='form' and run.status='succeeded' order by run.created_at`,
  );
  expect(runs.rows).toHaveLength(2);
  for (const [index, kind] of ['member', 'public'].entries())
    expect(runs.rows[index]).toMatchObject({
      started_by: index === 0 ? (expect.any(String) as unknown) : null,
      input_ref: {
        kind: 'inline',
        value: {
          values: { amount: 0, request_message: `${kind} request` },
          submittedBy: index === 0 ? (expect.any(String) as unknown) : null,
          submittedAt: expect.any(String) as unknown,
        },
      },
      output_ref: { kind: 'inline', value: { result: `${kind} answer` } },
    });
  expect(
    (
      await database.query(
        `select status,consumed_at is not null consumed from app.pending_run_tasks`,
      )
    ).rows,
  ).toEqual([
    { status: 'submitted', consumed: true },
    { status: 'submitted', consumed: true },
  ]);
  expect(
    (
      await database.query(
        `select access,capability_hash from app.workflow_forms`,
      )
    ).rows,
  ).toEqual([{ access: 'members', capability_hash: null }]);
  const audits = await database.query('select metadata from app.audit_events');
  expect(JSON.stringify(audits.rows)).not.toContain('member answer');
  expect(JSON.stringify(audits.rows)).not.toContain('public answer');
}
