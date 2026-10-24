import type { PoolClient } from 'pg';
import type { WorkflowCommentThread } from '@pertexo/contracts';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import type { ThreadScope } from './contract.js';
export interface StoredCommentThread {
  id: string;
  workflow_id: string;
  step_id: string | null;
  step_label: string | null;
  status: 'open' | 'resolved';
  revision: number;
  created_by: string | null;
  comment_count: number;
  created_at: Date;
  updated_at: Date;
  preview?: string | null;
}
export function projectCommentThread(
  row: StoredCommentThread,
): WorkflowCommentThread {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    stepId: row.step_id,
    stepLabel: row.step_label,
    status: row.status,
    revision: row.revision,
    createdBy: row.created_by,
    commentCount: row.comment_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    preview: row.preview ?? null,
  };
}
export async function lockCommentThread(
  client: PoolClient,
  input: ThreadScope,
) {
  const row = (
    await client.query<StoredCommentThread>(
      'select * from app.workflow_comment_threads where workspace_id=$1 and workflow_id=$2 and id=$3 for update',
      [input.workspaceId, input.workflowId, input.threadId],
    )
  ).rows[0];
  if (row === undefined)
    throw new WorkflowNotFoundError('Discussion is not visible');
  return row;
}
