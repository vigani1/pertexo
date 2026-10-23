import type { InvitationAcceptanceIntentPersistenceRecord } from '../../ports.js';
import {
  invitationAcceptanceJourneySchema,
  type InvitationAcceptanceJourney,
} from '../../types.js';

export function journey(
  intent: InvitationAcceptanceIntentPersistenceRecord,
  csrfToken: string,
  authenticatedUserId?: string,
  now: Date = new Date(),
): InvitationAcceptanceJourney {
  const base = {
    intentId: intent.id,
    expiresAt: intent.expiresAt.toISOString(),
    csrfToken,
  };
  if (intent.expiresAt.getTime() <= now.getTime())
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'expired',
    });
  if (intent.status === 'superseded')
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'superseded',
    });
  if (intent.status === 'abandoned') return { state: 'unavailable' };
  if (intent.invitationStatus === 'revoked')
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'revoked',
    });
  if (intent.invitationStatus === 'expired')
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'expired',
    });
  if (intent.status === 'wrong_account')
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'wrong_account',
    });
  if (intent.status === 'completed') {
    if (intent.receipt === null || intent.workspaceName === null)
      return { state: 'unavailable' };
    if (authenticatedUserId === undefined)
      return invitationAcceptanceJourneySchema.parse({
        ...base,
        state: 'sign_in_required',
      });
    if (authenticatedUserId !== intent.acceptedUserId)
      return invitationAcceptanceJourneySchema.parse({
        ...base,
        state: 'wrong_account',
      });
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'completed',
      workspace: { id: intent.workspaceId, name: intent.workspaceName },
      role: intent.receipt.role,
      membershipCreated: intent.receipt.membershipCreated,
    });
  }
  const verifiedForCurrentUser =
    intent.status === 'verified' &&
    intent.workspaceName !== null &&
    intent.invitationRole !== null &&
    authenticatedUserId === intent.verifiedUserId;
  if (verifiedForCurrentUser)
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'ready',
      workspace: { id: intent.workspaceId, name: intent.workspaceName },
      role: intent.invitationRole,
      invitationRevision: intent.invitationRevision,
      sessionRotationRequired: true,
    });
  return invitationAcceptanceJourneySchema.parse({
    ...base,
    state: 'sign_in_required',
  });
}
