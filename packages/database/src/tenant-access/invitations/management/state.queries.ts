import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  users,
  workspaces,
  workspaceMemberships,
  workspaceInvitations,
} from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { Role } from '@pertexo/workflow-model';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { WorkspaceInvitationRecord } from '../../contract.js';
import { WorkspaceInvitationCommandConflictError } from '../../errors.js';

import { durableInvitation } from './contract.js';

export function normalizeEmail(value: string): string {
  return z.email().max(320).parse(value.trim()).normalize('NFKC').toLowerCase();
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
  const db = drizzle(client);
  const workspace = await db
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for(strength)
    .catch(rethrowQueryFailure);
  if (workspace[0]?.status !== 'active')
    throw new WorkspaceInvitationCommandConflictError(
      'actor_inactive',
      'The workspace is not active',
    );
  const person = alias(users, 'users');
  const membership = alias(workspaceMemberships, 'membership');
  const actor = await db
    .select({
      role: membership.role,
      membership_status: membership.status,
      user_status: person.status,
    })
    .from(person)
    .innerJoin(membership, eq(membership.userId, person.id))
    .where(
      and(eq(person.id, actorUserId), eq(membership.workspaceId, workspaceId)),
    )
    .for(strength, { of: [person, membership] })
    .catch(rethrowQueryFailure);
  const row = actor[0];
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

export const invitationSelection = {
  id: workspaceInvitations.id,
  workspaceId: workspaceInvitations.workspaceId,
  email: workspaceInvitations.recipientEmail,
  role: workspaceInvitations.role,
  status: workspaceInvitations.status,
  revision: workspaceInvitations.revision,
  deliveryStatus: workspaceInvitations.deliveryStatus,
  expiresAt: workspaceInvitations.expiresAt,
  createdAt: workspaceInvitations.createdAt,
  updatedAt: workspaceInvitations.updatedAt,
};
