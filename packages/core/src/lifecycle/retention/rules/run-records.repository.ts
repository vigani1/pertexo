import {
  workflowRuns,
  nodeRuns,
  runEvents,
  runCheckpoints,
  dataTableWriteReceipts,
  webhookRunResponses,
} from '@pertexo/database/schema';
import { and, eq, exists, isNull, sql, type SQL } from 'drizzle-orm';
import {
  alias,
  QueryBuilder,
  type AnyPgColumn,
  type PgTable,
} from 'drizzle-orm/pg-core';
import {
  expiredRunSql,
  RUN_DETAILS_RETENTION_SQL,
} from '../../../runs/data-policy.js';
import { deletionRule } from '../deletion-rule.js';

const query = new QueryBuilder(),
  run = alias(workflowRuns, 'run');
function expiredOwner(workspace: AnyPgColumn, runId: AnyPgColumn) {
  return exists(
    query
      .select({ one: sql`1` })
      .from(run)
      .where(
        and(
          eq(run.workspaceId, workspace),
          eq(run.id, runId),
          expiredRunSql('run'),
        ),
      ),
  );
}
/**
 * For a run's step rows, events and checkpoint, which `run_details` waits for.
 * Starting from the runs, through `workflow_runs_detail_retention_idx`, is what
 * keeps an idle pass from reading the whole table: walking the rows and probing
 * each one's run read all of them when none was due. Only unpurged runs count
 * because a purged run has none of these rows. Should one appear later, it goes
 * with the run's summary, by cascade. The page has no order of its own, so the
 * planner has no reason to walk this table's key.
 */
function rowOfExpiredRun(
  table: PgTable,
  workspace: AnyPgColumn,
  runId: AnyPgColumn,
) {
  return (pageSize: number): SQL =>
    sql`(${workspace},${runId}) in ${query
      .select({ workspaceId: run.workspaceId, id: run.id })
      .from(run)
      .where(
        and(
          isNull(run.detailsPurgedAt),
          expiredRunSql('run'),
          exists(
            query
              .select({ one: sql`1` })
              .from(table)
              .where(and(eq(workspace, run.workspaceId), eq(runId, run.id))),
          ),
        ),
      )
      .orderBy(run.completedAt, run.id)
      .limit(pageSize)}`;
}
export const dataTableReceipts = deletionRule('data_table_write_receipts', {
  table: dataTableWriteReceipts,
  keys: [
    dataTableWriteReceipts.workspaceId,
    dataTableWriteReceipts.executionId,
    dataTableWriteReceipts.invocationId,
  ],
  condition: expiredOwner(
    dataTableWriteReceipts.workspaceId,
    dataTableWriteReceipts.runId,
  ),
  orderBy: [
    dataTableWriteReceipts.executionId,
    dataTableWriteReceipts.invocationId,
  ],
});
export const webhookResponses = deletionRule('webhook_responses', {
  table: webhookRunResponses,
  keys: [webhookRunResponses.runId],
  condition: exists(
    query
      .select({ one: sql`1` })
      .from(run)
      .where(
        and(
          eq(run.workspaceId, webhookRunResponses.workspaceId),
          eq(run.id, webhookRunResponses.runId),
          sql`${run.completedAt}<=clock_timestamp()-${RUN_DETAILS_RETENTION_SQL}`,
        ),
      ),
  ),
  orderBy: [webhookRunResponses.runId],
});
// Test details follow the creation window; ordinary details follow completion.
// Deleting a node run also deletes its attempts.
export const nodeDetails = deletionRule('node_runs', {
  table: nodeRuns,
  keys: [nodeRuns.workspaceId, nodeRuns.id],
  condition: rowOfExpiredRun(
    nodeRuns,
    nodeRuns.workspaceId,
    nodeRuns.workflowRunId,
  ),
  orderBy: [],
});
export const events = deletionRule('run_events', {
  table: runEvents,
  keys: [runEvents.workflowRunId, runEvents.sequence],
  condition: rowOfExpiredRun(
    runEvents,
    runEvents.workspaceId,
    runEvents.workflowRunId,
  ),
  orderBy: [],
});
export const checkpoints = deletionRule('run_checkpoints', {
  table: runCheckpoints,
  keys: [runCheckpoints.workflowRunId],
  condition: rowOfExpiredRun(
    runCheckpoints,
    runCheckpoints.workspaceId,
    runCheckpoints.workflowRunId,
  ),
  orderBy: [],
});
