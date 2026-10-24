import type { Role } from '@pertexo/workflow-model';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { WorkspaceInvitationRecord } from '../../contract.js';
import { WorkspaceInvitationCommandConflictError } from '../../errors.js';

import {
  delegatedRole,
  revision,
  durableInvitation,
  type InvitationRow,
} from './contract.js';

export function normalizeEmail(value: string): string {
  return z.email().max(320).parse(value.trim()).normalize('NFKC').toLowerCase();
}

export function mapInvitation(row: InvitationRow): WorkspaceInvitationRecord {
  return Object.freeze({
    id: z.uuid().parse(row.id),
    workspaceId: z.uuid().parse(row.workspace_id),
    email: z.email().parse(row.recipient_email),
    role: delegatedRole.parse(row.role),
    status: z
      .enum(['pending', 'accepted', 'revoked', 'expired'])
      .parse(row.status),
    revision: revision.parse(row.revision),
    deliveryStatus: z
      .enum(['queued', 'submitted', 'failed', 'canceled'])
      .parse(row.delivery_status),
    expiresAt: z.coerce.date().parse(row.expires_at),
    createdAt: z.coerce.date().parse(row.created_at),
    updatedAt: z.coerce.date().parse(row.updated_at),
  });
}

export function serializeInvitation(invitation: WorkspaceInvitationRecord) {
  return durableInvitation.parse({
    ...invitation,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    updatedAt: invitation.updatedAt.toISOString(),
  });
}

export // Locks always go workspace first, then the actor's user and membership,
// as the member store does, so no two transactions can wait on each other in
// a cycle. Reads take share locks: listing invitations while the members list
// loads must not deadlock; commands take update locks and still serialize.
async function lockAuthorizedActor(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string,
  strength: 'update' | 'share' = 'update',
): Promise<Role> {
  const workspace = await client.query<{ status: string }>(
    `select status from app.workspaces where id=$1 for ${strength}`,
    [workspaceId],
  );
  if (workspace.rows[0]?.status !== 'active')
    throw new WorkspaceInvitationCommandConflictError(
      'actor_inactive',
      'The workspace is not active',
    );
  const actor = await client.query<{
    role: Role;
    membership_status: string;
    user_status: string;
  }>(
    `select membership.role,membership.status membership_status,users.status user_status
       from app.users users
       join app.workspace_memberships membership on membership.user_id=users.id
      where users.id=$1 and membership.workspace_id=$2
      for ${strength} of users,membership`,
    [actorUserId, workspaceId],
  );
  const row = actor.rows[0];
  const managerUnavailable =
    row?.user_status !== 'active' ||
    row.membership_status !== 'active' ||
    (row.role !== 'owner' && row.role !== 'admin');
  if (managerUnavailable)
    throw new WorkspaceInvitationCommandConflictError(
      'actor_inactive',
      'The actor is no longer allowed to manage invitations',
    );
  return row.role;
}

export function mapDurableInvitation(
  invitation: z.output<typeof durableInvitation>,
): WorkspaceInvitationRecord {
  return Object.freeze({
    ...invitation,
    expiresAt: new Date(invitation.expiresAt),
    createdAt: new Date(invitation.createdAt),
    updatedAt: new Date(invitation.updatedAt),
  });
}

export const invitationSelection = `id,workspace_id,recipient_email,role,status,revision,
  delivery_status,expires_at,created_at,updated_at`;
