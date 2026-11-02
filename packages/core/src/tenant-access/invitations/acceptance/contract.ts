import type { IdentityWorkspaceStore } from '../../contract.js';

export type AcceptanceStore = Pick<
  IdentityWorkspaceStore,
  | 'resolveInvitationAcceptance'
  | 'readInvitationAcceptance'
  | 'recordInvitationAcceptanceProof'
  | 'completeInvitationAcceptance'
  | 'abandonInvitationAcceptance'
>;
