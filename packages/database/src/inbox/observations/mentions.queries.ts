import type { PoolClient } from 'pg';
import { NOTICE_WINDOW_SQL } from '../lifetime.js';
/** Match the authoring lock order before the FK acquires mention locks. */
export async function readCommentMentionSource(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; subjectId: string }>,
) {
  const first = (
    await client.query<{ workflow_id: string; thread_id: string }>(
      `select discussion.workflow_id,discussion.id thread_id from app.workflow_comment_mentions mention join app.workflow_comments comment on comment.workspace_id=mention.workspace_id and comment.id=mention.comment_id join app.workflow_comment_threads discussion on discussion.workspace_id=comment.workspace_id and discussion.id=comment.thread_id where mention.workspace_id=$1 and mention.id=$2`,
      [input.workspaceId, input.subjectId],
    )
  ).rows[0];
  if (first === undefined) return null;
  const workflow = await client.query(
    'select id from app.workflows where workspace_id=$1 and id=$2 for share',
    [input.workspaceId, first.workflow_id],
  );
  if (workflow.rowCount !== 1) return null;
  const discussion = await client.query(
    'select id from app.workflow_comment_threads where workspace_id=$1 and id=$2 for share',
    [input.workspaceId, first.thread_id],
  );
  if (discussion.rowCount !== 1) return null;
  const source = (
    await client.query<{ created_at: Date; active: boolean }>(
      `select mention.created_at,(mention.created_at>clock_timestamp()-${NOTICE_WINDOW_SQL} and mention.user_id is distinct from comment.author_id) active from app.workflow_comment_mentions mention join app.workflow_comments comment on comment.workspace_id=mention.workspace_id and comment.id=mention.comment_id where mention.workspace_id=$1 and mention.id=$2 and comment.thread_id=$3 for share of comment,mention`,
      [input.workspaceId, input.subjectId, first.thread_id],
    )
  ).rows[0];
  return source === undefined
    ? null
    : {
        workflowId: first.workflow_id,
        occurredAt: source.created_at,
        active: source.active,
      };
}
