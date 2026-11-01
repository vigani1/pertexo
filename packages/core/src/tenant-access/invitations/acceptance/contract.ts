import type { IdentityWorkspaceDatabase } from '../../contract.js';

export type AcceptanceStore = Pick<
  IdentityWorkspaceDatabase,
  | 'resolveInvitationAcceptance'
  | 'readInvitationAcceptance'
  | 'recordInvitationAcceptanceProof'
  | 'completeInvitationAcceptance'
  | 'abandonInvitationAcceptance'
>;
