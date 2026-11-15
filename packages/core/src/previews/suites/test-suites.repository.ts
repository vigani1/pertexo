import type { WorkflowActor } from '../../shared/workflow-actor.types.js';
import type { WorkflowTestSuiteSummary } from '@pertexo/contracts';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowTestSuiteCases,
  workflowTestSuites,
  workflowTestSnapshots,
} from '@pertexo/database/schema';
import { WORKFLOW_TEST_SUITE_MAX_CASES } from '@pertexo/workflow-model';

/** How many recent suites the history shows. */
const SUITE_HISTORY_ROWS = 20;

const suite = alias(workflowTestSuites, 'suite');
const historyFields = {
  id: suite.id,
  workspaceId: suite.workspaceId,
  snapshotId: suite.snapshotId,
  startedBy: suite.startedBy,
  signature: suite.signature,
  status: suite.status,
  stopReason: suite.stopReason,
  createdAt: suite.createdAt,
  completedAt: suite.completedAt,
  expiresAt: suite.expiresAt,
};
type SummarySource = typeof historyFields;

function suiteCounts(
  db: Pick<NodePgDatabase, 'select'>,
  source: SummarySource,
) {
  return db
    .select({
      total: sql<number>`count(*)::integer`.as('total'),
      passed:
        sql<number>`(count(*) filter(where ${workflowTestSuiteCases.status}='passed'))::integer`.as(
          'passed',
        ),
      failed:
        sql<number>`(count(*) filter(where ${workflowTestSuiteCases.status}='failed'))::integer`.as(
          'failed',
        ),
      errors:
        sql<number>`(count(*) filter(where ${workflowTestSuiteCases.status}='error'))::integer`.as(
          'errors',
        ),
      skipped:
        sql<number>`(count(*) filter(where ${workflowTestSuiteCases.status}='skipped'))::integer`.as(
          'skipped',
        ),
    })
    .from(workflowTestSuiteCases)
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, source.workspaceId),
        eq(workflowTestSuiteCases.suiteId, source.id),
      ),
    )
    .as('counts');
}
function summarySelection(
  source: SummarySource,
  counts: ReturnType<typeof suiteCounts>,
) {
  return {
    id: source.id,
    startedBy: source.startedBy,
    signature: source.signature,
    status: source.status,
    stopReason: source.stopReason,
    createdAt: source.createdAt,
    completedAt: source.completedAt,
    expiresAt: source.expiresAt,
    draftRevision: workflowTestSnapshots.draftRevision,
    total: counts.total,
    passed: counts.passed,
    failed: counts.failed,
    errors: counts.errors,
    skipped: counts.skipped,
  };
}
function visibleSuite(input: WorkflowActor) {
  return and(
    eq(suite.workspaceId, input.workspaceId),
    eq(suite.workflowId, input.workflowId),
    sql`${suite.expiresAt}>clock_timestamp()`,
  );
}
async function listSuiteRows(client: PoolClient, input: WorkflowActor) {
  const db = drizzle(client);
  // Counts depend on this bounded relation, so no other suite is aggregated.
  const history = db.$with('suite').as(
    db
      .select(historyFields)
      .from(suite)
      .where(visibleSuite(input))
      .orderBy(
        desc(
          sql`(${suite.startedBy}=${input.actorId} and ${suite.status}='running')`,
        ),
        desc(suite.createdAt),
        desc(suite.id),
      )
      .limit(SUITE_HISTORY_ROWS),
  );
  const counts = suiteCounts(db, history);
  return db
    .with(history)
    .select(summarySelection(history, counts))
    .from(history)
    .innerJoin(
      workflowTestSnapshots,
      and(
        eq(workflowTestSnapshots.workspaceId, history.workspaceId),
        eq(workflowTestSnapshots.id, history.snapshotId),
      ),
    )
    .crossJoinLateral(counts)
    .orderBy(
      desc(
        sql`(${history.startedBy}=${input.actorId} and ${history.status}='running')`,
      ),
      desc(history.createdAt),
      desc(history.id),
    )
    .catch(rethrowQueryFailure);
}
export function summary(
  row: Awaited<ReturnType<typeof listSuiteRows>>[number],
): WorkflowTestSuiteSummary {
  return {
    suiteId: row.id,
    startedBy: row.startedBy,
    draftRevision: row.draftRevision,
    signature: row.signature,
    status: row.status,
    stopReason: row.stopReason,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    total: row.total,
    passed: row.passed,
    failed: row.failed,
    errors: row.errors,
    skipped: row.skipped,
  };
}
export async function listSuites(
  client: PoolClient,
  input: WorkflowActor,
): Promise<readonly WorkflowTestSuiteSummary[]> {
  return (await listSuiteRows(client, input)).map(summary);
}
export async function readSuiteRow(
  client: PoolClient,
  input: WorkflowActor & { suiteId: string },
) {
  const db = drizzle(client);
  const counts = suiteCounts(db, historyFields);
  const found = await db
    .select(summarySelection(historyFields, counts))
    .from(suite)
    .innerJoin(
      workflowTestSnapshots,
      and(
        eq(workflowTestSnapshots.workspaceId, suite.workspaceId),
        eq(workflowTestSnapshots.id, suite.snapshotId),
      ),
    )
    .crossJoinLateral(counts)
    .where(and(visibleSuite(input), eq(suite.id, input.suiteId)))
    .catch(rethrowQueryFailure);
  return found[0];
}

export async function readSuiteCaseRows(
  client: PoolClient,
  input: WorkflowActor & { suiteId: string },
) {
  const db = drizzle(client);
  const cases = await db
    .select({
      ordinal: workflowTestSuiteCases.ordinal,
      caseId: workflowTestSuiteCases.caseId,
      caseRevision: workflowTestSuiteCases.caseRevision,
      name: workflowTestSuiteCases.name,
      status: workflowTestSuiteCases.status,
      runId: workflowTestSuiteCases.runId,
    })
    .from(workflowTestSuiteCases)
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, input.workspaceId),
        eq(workflowTestSuiteCases.suiteId, input.suiteId),
      ),
    )
    .orderBy(asc(workflowTestSuiteCases.ordinal))
    .limit(WORKFLOW_TEST_SUITE_MAX_CASES)
    .catch(rethrowQueryFailure);
  return cases;
}

export async function readCaseReportRow(
  client: PoolClient,
  input: WorkflowActor & { suiteId: string; ordinal: number },
) {
  const db = drizzle(client);
  const found = await db
    .select({
      report: workflowTestSuiteCases.report,
      snapshotId: suite.snapshotId,
    })
    .from(workflowTestSuiteCases)
    .innerJoin(
      suite,
      and(
        eq(suite.workspaceId, workflowTestSuiteCases.workspaceId),
        eq(suite.id, workflowTestSuiteCases.suiteId),
      ),
    )
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, input.workspaceId),
        eq(suite.workflowId, input.workflowId),
        eq(suite.id, input.suiteId),
        eq(workflowTestSuiteCases.ordinal, input.ordinal),
        sql`${suite.expiresAt}>clock_timestamp()`,
      ),
    )
    .catch(rethrowQueryFailure);
  return found[0];
}

export async function readSnapshotGraph(
  client: PoolClient,
  workspaceId: string,
  snapshotId: string,
) {
  const [source] = await drizzle(client)
    .select({ graph: workflowTestSnapshots.graphJson })
    .from(workflowTestSnapshots)
    .where(
      and(
        eq(workflowTestSnapshots.workspaceId, workspaceId),
        eq(workflowTestSnapshots.id, snapshotId),
      ),
    )
    .catch(rethrowQueryFailure);
  return source;
}
