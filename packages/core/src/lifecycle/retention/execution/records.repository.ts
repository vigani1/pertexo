import {
  workflowRuns,
  nodeRuns,
  runEvents,
  runCheckpoints,
  dataTableWriteReceipts,
  webhookRunResponses,
} from '@pertexo/database/schema';
import { and, eq, exists, sql } from 'drizzle-orm';
import { alias, QueryBuilder, type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  expiredRunSql,
  RUN_DETAILS_RETENTION_SQL,
} from '../../../runs/data-policy.js';
import { deletionRule } from '../rows.repository.js';

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
  condition: expiredOwner(nodeRuns.workspaceId, nodeRuns.workflowRunId),
  orderBy: [nodeRuns.id],
});
export const events = deletionRule('run_events', {
  table: runEvents,
  keys: [runEvents.workflowRunId, runEvents.sequence],
  condition: expiredOwner(runEvents.workspaceId, runEvents.workflowRunId),
  orderBy: [runEvents.workflowRunId, runEvents.sequence],
});
export const checkpoints = deletionRule('run_checkpoints', {
  table: runCheckpoints,
  keys: [runCheckpoints.workflowRunId],
  condition: expiredOwner(
    runCheckpoints.workspaceId,
    runCheckpoints.workflowRunId,
  ),
  orderBy: [runCheckpoints.workflowRunId],
});
