import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workspaceInvitations as invitations } from '@pertexo/database/schema';

import { expireWorkspaceInvitations } from '../expiration.repository.js';

import { WorkspaceAccessDeniedError } from '../../../shared/errors.js';
import { withWorkspaceAccess } from '../../../shared/workspace-access.js';
import { WorkspaceInvitationCommandConflictError } from '../../errors.js';
import type { InvitationStore } from './contract.js';
import { invitationSelection } from './state.queries.js';

export async function listWorkspaceInvitations(
  pool: Pool,
  workspaceId: Parameters<InvitationStore['listWorkspaceInvitations']>[0],
  actorUserId: Parameters<InvitationStore['listWorkspaceInvitations']>[1],
  input: Parameters<InvitationStore['listWorkspaceInvitations']>[2] = {},
): ReturnType<InvitationStore['listWorkspaceInvitations']> {
  const limit = input.limit ?? 50;
  // Share locks, not a snapshot: it writes the expiries it finds, and listing
  // invitations while the members list loads must not deadlock.
  return withWorkspaceAccess(
    pool,
    { workspaceId, actorId: actorUserId },
    {
      mode: 'change',
      capability: 'member:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
    },
    async (client) => {
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
  ).catch((error: unknown) => {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new WorkspaceInvitationCommandConflictError(
        'actor_inactive',
        'The actor is no longer allowed to manage invitations',
        { cause: error },
      );
    throw error;
  });
}
