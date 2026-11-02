import type { WorkspaceInvitationRecord } from '../../contract.js';

export type DurableInvitationResult = Readonly<{
  invitation: ReturnType<typeof serializeInvitation>;
}>;

export function serializeInvitation(invitation: WorkspaceInvitationRecord) {
  return {
    ...invitation,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    updatedAt: invitation.updatedAt.toISOString(),
  };
}

export function mapDurableInvitation(
  invitation: DurableInvitationResult['invitation'],
): WorkspaceInvitationRecord {
  return Object.freeze({
    ...invitation,
    expiresAt: new Date(invitation.expiresAt),
    createdAt: new Date(invitation.createdAt),
    updatedAt: new Date(invitation.updatedAt),
  });
}
