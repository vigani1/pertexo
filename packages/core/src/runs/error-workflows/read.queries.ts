import {
  runErrorWorkflowIntents,
  workflowRuns,
} from '@pertexo/database/schema';

import { and, eq, sql } from 'drizzle-orm';

import type { WorkspaceTransaction } from '@pertexo/database/primitives';

export async function readErrorWorkflow(
  transaction: WorkspaceTransaction,
  runId: string,
) {
  const [row] = await transaction.db
    .select({
      status: runErrorWorkflowIntents.status,
      targetWorkflowId: runErrorWorkflowIntents.targetWorkflowId,
      targetVersionId: runErrorWorkflowIntents.targetVersionId,
      acceptedRunId: workflowRuns.id,
      refusalCode: runErrorWorkflowIntents.refusalCode,
      queueWaitExpiresAt: sql<
        string | null
      >`to_char(${runErrorWorkflowIntents.queueWaitExpiresAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(runErrorWorkflowIntents)
    .leftJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, runErrorWorkflowIntents.workspaceId),
        eq(workflowRuns.id, runErrorWorkflowIntents.acceptedRunId),
      ),
    )
    .where(
      and(
        eq(runErrorWorkflowIntents.workspaceId, transaction.workspaceId),
        eq(runErrorWorkflowIntents.sourceRunId, runId),
      ),
    );
  return row === undefined ? {} : { errorWorkflow: row };
}
