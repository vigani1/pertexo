import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';
import type { Pool } from 'pg';

import { expireWorkspaceInvitations } from '../expiration.repository.js';

import { WorkspaceAccessDeniedError } from '../../../shared/workspace-access.errors.js';
import { withWorkspaceAccess } from '../../../shared/workspace-access.js';
import { WorkspaceInvitationCommandConflictError } from '../../tenant-access.errors.js';
import { DEFAULT_PAGE_LIMIT } from '../../../shared/page-limits.js';
import type {
  ListWorkspaceInvitationsInput,
  WorkspaceInvitationsPage,
} from '../../tenant-access.types.js';
import { readInvitationPage } from './list.repository.js';

export async function listWorkspaceInvitations(
  pool: Pool,
  workspaceId: string,
  actorUserId: string,
  input: ListWorkspaceInvitationsInput = {},
): Promise<WorkspaceInvitationsPage> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
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
      const result = await readInvitationPage(
        client,
        workspaceId,
        input,
        limit,
      );
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
