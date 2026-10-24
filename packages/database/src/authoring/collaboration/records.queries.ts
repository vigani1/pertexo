import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowCommentThreads } from '../../schema/authoring/collaboration/threads.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import type { WorkflowCommentThread } from '@pertexo/contracts';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import type { ThreadScope } from './contract.js';
export type StoredCommentThread = typeof workflowCommentThreads.$inferSelect & {
  preview?: string | null;
};
export function projectCommentThread(
  row: StoredCommentThread,
): WorkflowCommentThread {
  return {
    id: row.id,
    workflowId: row.workflowId,
    stepId: row.stepId,
    stepLabel: row.stepLabel,
    status: row.status,
    revision: row.revision,
    createdBy: row.createdBy,
    commentCount: row.commentCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    preview: row.preview ?? null,
  };
}
export async function lockCommentThread(
  client: PoolClient,
  input: ThreadScope,
) {
  const [row] = await drizzle(client)
    .select()
    .from(workflowCommentThreads)
    .where(
      and(
        eq(workflowCommentThreads.workspaceId, input.workspaceId),
        eq(workflowCommentThreads.workflowId, input.workflowId),
        eq(workflowCommentThreads.id, input.threadId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new WorkflowNotFoundError('Discussion is not visible');
  return row;
}
