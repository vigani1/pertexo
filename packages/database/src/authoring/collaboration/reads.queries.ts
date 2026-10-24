import type { PoolClient } from 'pg';
import type { WorkflowComment } from '@pertexo/contracts';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import { readWorkspacePeople } from '../../tenant-access/members/discovery.queries.js';
import { projectCommentThread, type StoredCommentThread } from './records.queries.js';
import { requireCollaborationAuthority } from './authority.queries.js';
import type {
  CollaborationContext,
  WorkflowCollaborationStore,
} from './contract.js';
const threadProjection = `thread.*,(select left(entry.body,200) from app.workflow_comments entry where entry.workspace_id=thread.workspace_id and entry.thread_id=thread.id order by entry.id desc limit 1) preview`;
interface StoredComment {
  id: string;
  thread_id: string;
  author_id: string | null;
  author_name: string;
  body: string;
  revision: number;
  created_at: Date;
  edited_at: Date | null;
}
async function projectComments(
  client: PoolClient,
  workspaceId: string,
  rows: readonly StoredComment[],
): Promise<WorkflowComment[]> {
  const mentions = await client.query<{
    comment_id: string;
    user_id: string;
    display_name: string;
  }>(
    'select mention.comment_id,mention.user_id,actor.display_name from app.workflow_comment_mentions mention join app.users actor on actor.id=mention.user_id where mention.workspace_id=$1 and mention.comment_id=any($2::uuid[]) order by mention.id',
    [workspaceId, rows.map((row) => row.id)],
  );
  const byComment = new Map<
    string,
    { userId: string; displayName: string }[]
  >();
  for (const mention of mentions.rows) {
    const people = byComment.get(mention.comment_id) ?? [];
    people.push({ userId: mention.user_id, displayName: mention.display_name });
    byComment.set(mention.comment_id, people);
  }
  return rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
    mentions: byComment.get(row.id) ?? [],
  }));
}
export function collaborationReads(
  context: CollaborationContext,
): Pick<WorkflowCollaborationStore, 'list' | 'read' | 'people'> {
  return {
    list: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireCollaborationAuthority(client, input);
          const found = await client.query<StoredCommentThread>(
            `select ${threadProjection} from app.workflow_comment_threads thread where thread.workspace_id=$1 and thread.workflow_id=$2 and ($3::uuid is null or thread.id<$3) and ($4='all' or thread.status=$4) and ($5='all' or ($5='workflow' and thread.step_id is null) or ($5='step' and thread.step_id=$6)) order by thread.id desc limit $7`,
            [
              input.workspaceId,
              input.workflowId,
              input.after ?? null,
              input.status,
              input.scope,
              input.stepId ?? null,
              input.limit + 1,
            ],
          );
          const rows = found.rows.slice(0, input.limit);
          return {
            items: rows.map(projectCommentThread),
            nextCursor:
              found.rows.length > input.limit
                ? (rows.at(-1)?.id ?? null)
                : null,
          };
        },
        input.signal,
      ),
    read: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireCollaborationAuthority(client, input);
          const thread = (
            await client.query<StoredCommentThread>(
              `select ${threadProjection} from app.workflow_comment_threads thread where thread.workspace_id=$1 and thread.workflow_id=$2 and thread.id=$3`,
              [input.workspaceId, input.workflowId, input.threadId],
            )
          ).rows[0];
          if (thread === undefined)
            throw new WorkflowNotFoundError('Discussion is not visible');
          if (input.anchor !== undefined) {
            const anchor = await client.query(
              'select id from app.workflow_comments where workspace_id=$1 and thread_id=$2 and id=$3',
              [input.workspaceId, input.threadId, input.anchor],
            );
            if (anchor.rowCount !== 1)
              throw new WorkflowNotFoundError('Comment is not visible');
          }
          const found = await client.query<StoredComment>(
            `select entry.*,coalesce(actor.display_name,'Former member') author_name from app.workflow_comments entry left join app.users actor on actor.id=entry.author_id where entry.workspace_id=$1 and entry.thread_id=$2 and ($3::uuid is null or entry.id<$3) and ($4::uuid is null or entry.id<=$4) order by entry.id desc limit $5`,
            [
              input.workspaceId,
              input.threadId,
              input.before ?? null,
              input.anchor ?? null,
              input.limit + 1,
            ],
          );
          const rows = found.rows.slice(0, input.limit);
          return {
            thread: projectCommentThread(thread),
            comments: await projectComments(client, input.workspaceId, rows),
            nextCursor:
              found.rows.length > input.limit
                ? (rows.at(-1)?.id ?? null)
                : null,
          };
        },
        input.signal,
      ),
    people: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireCollaborationAuthority(client, input);
          return readWorkspacePeople(client, input);
        },
        input.signal,
      ),
  };
}
