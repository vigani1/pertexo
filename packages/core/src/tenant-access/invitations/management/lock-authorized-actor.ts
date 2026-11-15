import type { Role } from '@pertexo/policy';
import type { PoolClient } from 'pg';
import { lockWorkspaceRow } from '../../../shared/authority.repository.js';
import { WorkspaceInvitationCommandConflictError } from '../../tenant-access.errors.js';
import { isActiveMemberManager } from '../../members/manager.js';
import { lockActorMembership } from './state.repository.js';

/**
 * A command takes the workspace, then the actor's user and membership, for
 * update, as the member commands do, so no two wait on each other in a cycle. It
 * stays off withWorkspaceAccess: that helper's share lock on the user would come
 * first, and two commands by one person in two workspaces would each hold it and
 * wait for the other's update, dying with 40P01.
 */
export async function lockAuthorizedActor(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string,
): Promise<Role> {
  if ((await lockWorkspaceRow(client, workspaceId)) !== 'active')
    throw new WorkspaceInvitationCommandConflictError(
      'actor_inactive',
      'The workspace is not active',
    );
  const row = await lockActorMembership(client, workspaceId, actorUserId);
  if (!isActiveMemberManager(row))
    throw new WorkspaceInvitationCommandConflictError(
      'actor_inactive',
      'The actor is no longer allowed to manage invitations',
    );
  return row.role;
}
