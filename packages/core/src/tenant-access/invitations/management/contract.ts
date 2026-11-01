import type { IdentityWorkspaceDatabase } from '../../contract.js';

export type InvitationStore = Pick<
  IdentityWorkspaceDatabase,
  | 'listWorkspaceInvitations'
  | 'createWorkspaceInvitation'
  | 'resendWorkspaceInvitation'
  | 'revokeWorkspaceInvitation'
>;
