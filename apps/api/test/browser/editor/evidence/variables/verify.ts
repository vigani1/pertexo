import type { Pool } from 'pg';
import { expect } from 'vitest';
export async function verifyVariableEvidence(database: Pool) {
  const runs = await database.query<{
    variable_snapshot: unknown;
    output_ref: unknown;
  }>(
    "select variable_snapshot,node.output_ref from app.workflow_runs run join app.node_runs node on node.workflow_run_id=run.id and node.node_id='finish' where run.status='succeeded' order by run.created_at,run.id",
  );
  expect(runs.rows).toEqual(
    [10, 10, 20].map((rate) => ({
      variable_snapshot: {
        revision: rate === 10 ? 1 : 2,
        values: { RATE: rate },
      },
      output_ref: { kind: 'inline', value: { result: rate } },
    })),
  );
  const audits = await database.query(
    "select metadata from app.audit_events where action='workspace.variables_changed' order by occurred_at,id",
  );
  expect(audits.rows).toEqual([
    { metadata: { revision: 1, changedNames: ['RATE'] } },
    { metadata: { revision: 2, changedNames: ['RATE'] } },
  ]);
  expect(
    (
      await database.query(
        'select count(*)::int n from app.workspace_variables',
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
}
