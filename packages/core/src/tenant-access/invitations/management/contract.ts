import type { IdentityWorkspaceStore } from '../../contract.js';

export type InvitationStore = Pick<
  IdentityWorkspaceStore,
  | 'listWorkspaceInvitations'
  | 'createWorkspaceInvitation'
  | 'resendWorkspaceInvitation'
  | 'revokeWorkspaceInvitation'
>;
