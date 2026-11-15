import { decodeStoredValue } from '../../shared/stored-values.js';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import { TEST_RUN_RETENTION_MILLIS } from '../../runs/data-policy.js';
import { admitTestRun } from '../workflows/admit.js';
import { extendTestSnapshotRetention } from '../workflows/snapshot.repository.js';
import { startPendingCase } from './cases.repository.js';
import type { SuiteCaseRow, SuiteRow } from './workflow-test-suite.types.js';
export async function admitSuiteCase(
  client: PoolClient,
  suite: SuiteRow,
  entry: SuiteCaseRow,
  now: Date,
): Promise<void> {
  const input: unknown = decodeStoredValue((): unknown =>
    JSON.parse(entry.input),
  );
  const accepted = await admitTestRun(client, {
    workspaceId: suite.workspaceId,
    workflowId: suite.workflowId,
    actorId: suite.startedBy,
    runId: generatePersistedId(),
    snapshotId: suite.snapshotId,
    input,
    initialCheckpoint: suite.initialCheckpoint,
    variableSetRevision: suite.variableSetRevision,
    deadlineAt: new Date(
      Math.min(
        suite.deadlineAt.getTime(),
        now.getTime() + suite.caseDurationMs,
      ),
    ),
    command: {
      scope: `test-suite:${suite.id}`,
      key: String(entry.ordinal),
      request: {
        suiteId: suite.id,
        ordinal: entry.ordinal,
        caseId: entry.caseId,
        revision: entry.caseRevision,
        snapshotId: suite.snapshotId,
        input,
      },
    },
  });
  await extendTestSnapshotRetention(
    client,
    suite,
    new Date(accepted.acceptedAt.getTime() + TEST_RUN_RETENTION_MILLIS),
  );
  const started = await startPendingCase(
    client,
    { workspaceId: suite.workspaceId, suiteId: suite.id },
    entry.ordinal,
    accepted.runId,
  );
  if (!started) throw new Error('Suite case admission lost its pending case');
}
