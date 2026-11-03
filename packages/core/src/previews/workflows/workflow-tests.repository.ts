import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowRuns, workflowTestSnapshots } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  testRunSql,
  retainedTestRunSql,
  runRetentionIntervalSql,
} from '../../runs/data-policy.js';
import type { PoolClient } from 'pg';

import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { WorkflowTestError } from './errors.js';
import { ACTIVE_TEST_RUN_STATUSES } from './rules.js';
import type { WorkflowTestDetail, WorkflowTestSummary } from './contract.js';

const run = alias(workflowRuns, 'run');
const testSummarySelection = {
  runId: run.id,
  draftRevision: workflowTestSnapshots.draftRevision,
  status: run.status,
  createdAt: run.createdAt,
  startedBy: run.startedBy,
  expiresAt:
    sql<Date>`${run.createdAt}+${runRetentionIntervalSql('run')}`.mapWith(
      run.createdAt,
    ),
};
function visibleTest(input: SampleScope) {
  return and(
    eq(workflowTestSnapshots.workspaceId, input.workspaceId),
    eq(run.workflowId, input.workflowId),
    testRunSql('run'),
    retainedTestRunSql('run'),
    sql`${workflowTestSnapshots.expiresAt}>clock_timestamp()`,
  );
}
function listTestRows(client: PoolClient, input: SampleScope) {
  return drizzle(client)
    .select(testSummarySelection)
    .from(workflowTestSnapshots)
    .innerJoin(
      run,
      and(
        eq(run.workspaceId, workflowTestSnapshots.workspaceId),
        eq(run.workflowVersionId, workflowTestSnapshots.id),
      ),
    )
    .where(visibleTest(input))
    .orderBy(
      sql`(${run.startedBy}=${input.actorId} and ${inArray(run.status, ACTIVE_TEST_RUN_STATUSES)}) desc nulls last`,
      desc(run.createdAt),
      desc(run.id),
    )
    .limit(20)
    .catch(rethrowQueryFailure);
}
function summary(
  row: Awaited<ReturnType<typeof listTestRows>>[number],
): WorkflowTestSummary {
  return {
    runId: row.runId,
    startedBy: row.startedBy,
    draftRevision: row.draftRevision,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
export async function listTests(client: PoolClient, input: SampleScope) {
  const rows = await listTestRows(client, input);
  return { items: rows.map(summary) };
}
export async function readTestDetail(
  client: PoolClient,
  input: SampleScope & { runId: string },
): Promise<WorkflowTestDetail> {
  const rows = await drizzle(client)
    .select({
      ...testSummarySelection,
      graphJson: workflowTestSnapshots.graphJson,
      dispositions: workflowTestSnapshots.dispositions,
    })
    .from(workflowTestSnapshots)
    .innerJoin(
      run,
      and(
        eq(run.workspaceId, workflowTestSnapshots.workspaceId),
        eq(run.workflowVersionId, workflowTestSnapshots.id),
      ),
    )
    .where(and(visibleTest(input), eq(run.id, input.runId)))
    .catch(rethrowQueryFailure);
  const row = rows[0];
  if (row === undefined) throw new WorkflowTestError('not_found');
  return {
    ...summary(row),
    graph: row.graphJson,
    dispositions: row.dispositions,
  };
}
