import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { workspaceInvitations as invitations } from '@pertexo/database/schema';

import { expireWorkspaceInvitations } from '../expiration.repository.js';

import type { InvitationStore } from './contract.js';
import { invitationSelection, lockAuthorizedActor } from './state.queries.js';

export async function listWorkspaceInvitations(
  pool: Pool,
  workspaceId: Parameters<InvitationStore['listWorkspaceInvitations']>[0],
  actorUserId: Parameters<InvitationStore['listWorkspaceInvitations']>[1],
  input: Parameters<InvitationStore['listWorkspaceInvitations']>[2] = {},
): ReturnType<InvitationStore['listWorkspaceInvitations']> {
  const limit = input.limit ?? 50;
  return withTenantScopedClient(
    pool,
    { workspaceId, actorId: actorUserId },
    async (client) => {
      await lockAuthorizedActor(client, workspaceId, actorUserId, {
        strength: 'share',
        workspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
      });
      await expireWorkspaceInvitations(client, { workspaceId });
      const afterId =
        input.after === undefined ? undefined : input.after.invitationId;
      const result = await drizzle(client)
        .select({
          ...invitationSelection,
          created_at_cursor: sql<string>`to_char(${invitations.createdAt},'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(invitations)
        .where(
          and(
            eq(invitations.workspaceId, workspaceId),
            input.after === undefined
              ? undefined
              : sql`(${invitations.createdAt},${invitations.id})<(${input.after.createdAt}::timestamptz,${afterId}::uuid)`,
          ),
        )
        .orderBy(desc(invitations.createdAt), desc(invitations.id))
        .limit(limit + 1)
        .catch(rethrowQueryFailure);
      const visible = result.slice(0, limit);
      const last = visible.at(-1);
      return Object.freeze({
        items: Object.freeze(
          visible.map(({ created_at_cursor: _cursor, ...invitation }) =>
            Object.freeze(invitation),
          ),
        ),
        ...(result.length > limit && last?.created_at_cursor !== undefined
          ? {
              nextCursor: Object.freeze({
                createdAt: last.created_at_cursor,
                invitationId: last.id,
              }),
            }
          : {}),
      });
    },
  );
}
