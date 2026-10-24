import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/workflow-model';

/** Names-only directory; the caller owns its workspace and capability fence. */
export async function readWorkspacePeople(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    after?: string | undefined;
    q: string;
  }>,
) {
  const rows = await client.query<{
    userId: string;
    displayName: string;
    role: Role;
  }>(
    `select member.user_id "userId",actor.display_name "displayName",member.role from app.workspace_memberships member join app.users actor on actor.id=member.user_id and actor.status='active'
        where member.workspace_id=$1 and member.status='active' and ($2::uuid is null or member.user_id>$2) and position(lower($3) in lower(actor.display_name))>0 order by member.user_id limit 51`,
    [input.workspaceId, input.after ?? null, input.q],
  );
  const page = rows.rows.slice(0, 50);
  return {
    items: page,
    nextCursor: rows.rows.length > 50 ? (page.at(-1)?.userId ?? null) : null,
  };
}
