import type { PoolClient } from 'pg';
import { hasCapability, type Role } from '@pertexo/workflow-model';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  WorkflowCollaborationError,
  type CollaborationScope,
} from './contract.js';
export async function syncCommentMentions(
  client: PoolClient,
  input: CollaborationScope,
  commentId: string,
  userIds: readonly string[],
) {
  if (userIds.length > 0) {
    const members = await client.query<{ user_id: string; role: Role }>(
      `select member.user_id,member.role from app.workspace_memberships member join app.users actor on actor.id=member.user_id where member.workspace_id=$1 and member.user_id=any($2::uuid[]) and member.status='active' and actor.status='active' for share of member,actor`,
      [input.workspaceId, userIds],
    );
    if (
      members.rows.length !== userIds.length ||
      members.rows.some(
        (member) => !hasCapability(member.role, 'workflow:read'),
      )
    )
      throw new WorkflowCollaborationError(
        'conflict',
        'A mentioned person no longer has access. Remove them and review the comment before trying again.',
      );
  }
  await client.query(
    'delete from app.workflow_comment_mentions where workspace_id=$1 and comment_id=$2 and not(user_id=any($3::uuid[]))',
    [input.workspaceId, commentId, userIds],
  );
  for (const userId of userIds)
    await client.query(
      'insert into app.workflow_comment_mentions(workspace_id,id,comment_id,user_id) values($1,$2,$3,$4) on conflict(workspace_id,comment_id,user_id) do nothing',
      [input.workspaceId, generatePersistedId(), commentId, userId],
    );
}
