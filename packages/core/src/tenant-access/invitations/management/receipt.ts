import { z } from 'zod';
import type { WorkspaceInvitationRecord } from '../../contract.js';
import { delegatedRole, revision } from '../input.js';

export const durableInvitation = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    email: z.email().max(320),
    role: delegatedRole,
    status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    revision,
    deliveryStatus: z.enum(['queued', 'submitted', 'failed', 'canceled']),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const durableResult = z
  .object({ invitation: durableInvitation })
  .strict();

export function serializeInvitation(invitation: WorkspaceInvitationRecord) {
  return {
    ...invitation,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    updatedAt: invitation.updatedAt.toISOString(),
  };
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
