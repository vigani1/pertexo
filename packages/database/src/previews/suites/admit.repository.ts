import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { TEST_RUN_RETENTION_MILLIS } from '../../runs/data-policy.js';
import { admitTestRun } from '../workflows/admit.repository.js';
import type { SuiteRow, SuiteCaseRow } from './contract.js';
export async function admitSuiteCase(
  client: PoolClient,
  suite: SuiteRow,
  entry: SuiteCaseRow,
  now: Date,
): Promise<void> {
  const input = JSON.parse(entry.input) as unknown;
  const accepted = await admitTestRun(client, {
    workspaceId: suite.workspace_id,
    workflowId: suite.workflow_id,
    actorId: suite.started_by,
    runId: generatePersistedId(),
    snapshotId: suite.snapshot_id,
    input,
    initialCheckpoint: suite.initial_checkpoint,
    variableSetRevision: suite.variable_set_revision,
    deadlineAt: new Date(
      Math.min(
        suite.deadline_at.getTime(),
        now.getTime() + suite.case_duration_ms,
      ),
    ),
    command: {
      scope: `test-suite:${suite.id}`,
      key: String(entry.ordinal),
      request: {
        suiteId: suite.id,
        ordinal: entry.ordinal,
        caseId: entry.case_id,
        revision: entry.case_revision,
        snapshotId: suite.snapshot_id,
        input,
      },
    },
  });
  await client.query(
    'update app.workflow_test_snapshots set expires_at=greatest(expires_at,$3) where workspace_id=$1 and id=$2',
    [
      suite.workspace_id,
      suite.snapshot_id,
      new Date(accepted.acceptedAt.getTime() + TEST_RUN_RETENTION_MILLIS),
    ],
  );
  const changed = await client.query(
    "update app.workflow_test_suite_cases set run_id=$4,status='running' where workspace_id=$1 and suite_id=$2 and ordinal=$3 and status='pending'",
    [suite.workspace_id, suite.id, entry.ordinal, accepted.runId],
  );
  if (changed.rowCount !== 1)
    throw new Error('Suite case admission lost its pending case');
}
