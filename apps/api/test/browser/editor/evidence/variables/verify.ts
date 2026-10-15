import type { Pool } from 'pg';
import { expect } from 'vitest';
export async function verifyVariableEvidence(database: Pool) {
  const runs = await database.query<{
    variable_set_revision: number;
    values_json: unknown;
    output_ref: unknown;
  }>(
    "select run.variable_set_revision,variable_set.values_json,node.output_ref from app.workflow_runs run join app.workspace_variable_set_revisions variable_set on variable_set.workspace_id=run.workspace_id and variable_set.revision=run.variable_set_revision join app.node_runs node on node.workflow_run_id=run.id and node.node_id='finish' where run.status='succeeded' order by run.created_at,run.id",
  );
  expect(runs.rows).toEqual(
    [10, 10, 20].map((rate) => ({
      variable_set_revision: rate === 10 ? 1 : 2,
      values_json: { RATE: rate },
      output_ref: { kind: 'inline', value: { result: rate } },
    })),
  );
  expect(
    (
      await database.query(
        'select count(*)::int n from app.workspace_variable_set_revisions',
      )
    ).rows,
  ).toEqual([{ n: 2 }]);
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
