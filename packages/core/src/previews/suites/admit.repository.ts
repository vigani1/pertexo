import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { TEST_RUN_RETENTION_MILLIS } from '../../runs/data-policy.js';
import {
  workflowTestSuiteCases,
  workflowTestSnapshots,
} from '@pertexo/database/schema';
import { admitTestRun } from '../workflows/admit.repository.js';
import type { SuiteCaseRow, SuiteRow } from './contract.js';
export async function admitSuiteCase(
  client: PoolClient,
  suite: SuiteRow,
  entry: SuiteCaseRow,
  now: Date,
): Promise<void> {
  const input: unknown = JSON.parse(entry.input);
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
  const db = drizzle(client);
  await db
    .update(workflowTestSnapshots)
    .set({
      expiresAt: sql`greatest(${workflowTestSnapshots.expiresAt},${new Date(accepted.acceptedAt.getTime() + TEST_RUN_RETENTION_MILLIS)})`,
    })
    .where(
      and(
        eq(workflowTestSnapshots.workspaceId, suite.workspaceId),
        eq(workflowTestSnapshots.id, suite.snapshotId),
      ),
    )
    .catch(rethrowQueryFailure);
  const changed = await db
    .update(workflowTestSuiteCases)
    .set({ runId: accepted.runId, status: 'running' })
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, suite.workspaceId),
        eq(workflowTestSuiteCases.suiteId, suite.id),
        eq(workflowTestSuiteCases.ordinal, entry.ordinal),
        eq(workflowTestSuiteCases.status, 'pending'),
      ),
    )
    .returning({ ordinal: workflowTestSuiteCases.ordinal })
    .catch(rethrowQueryFailure);
  if (changed.length !== 1)
    throw new Error('Suite case admission lost its pending case');
}
