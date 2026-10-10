export {
  AUTHORIZATION_CAPABILITIES,
  capabilitiesForRole,
  hasCapability,
  ROLES,
  rolesForCapability,
} from './policy.js';
export type { AuthorizationCapability, Role } from './policy.js';
export {
  createIdentityWorkspaceDatabase,
  IdentityConflictError,
  InvitationAcceptanceConflictError,
  UserProfileCommandConflictError,
  WorkspaceAccessDeniedError,
  WorkspaceInvitationCommandConflictError,
  WorkspaceLifecycleConflictError,
  WorkspaceMemberRemovalCommandConflictError,
  WorkspaceMemberRoleCommandConflictError,
  WorkspaceMembershipCommandConflictError,
  WorkspaceRenameCommandConflictError,
} from './database.js';
export type {
  AccessibleWorkspaceRecord,
  AccessibleWorkspacesPage,
  ChangeWorkspaceInvitationInput,
  ChangeWorkspaceMemberRoleInput,
  CompleteInvitationAcceptanceInput,
  CreateWorkspaceInvitationInput,
  DelegatedMembershipRole,
  IdentityWorkspaceDatabase,
  InvitationAcceptanceIntentRecord,
  InvitationAcceptanceResult,
  LeaveWorkspaceInput,
  RemoveWorkspaceMemberInput,
  RenameWorkspaceInput,
  ResolveInvitationAcceptanceInput,
  SealedInvitationToken,
  TransferWorkspaceOwnershipInput,
  UpdateUserProfileInput,
  UserProfileUpdateResult,
  UserRecord,
  WorkspaceInvitationCommandResult,
  WorkspaceInvitationRecord,
  WorkspaceInvitationsPage,
  WorkspaceMemberRecord,
  WorkspaceMemberRemovalCommandConflictReason,
  WorkspaceMemberRemovalResult,
  WorkspaceMemberRoleChangeResult,
  WorkspaceMemberRoleCommandConflictReason,
  WorkspaceMembershipCommandConflictReason,
  WorkspaceMembersPage,
  WorkspaceMemberStatusCommandInput,
  WorkspaceMemberStatusResult,
  WorkspaceOwnershipTransferResult,
  WorkspaceRenameResult,
} from './database.js';
export { createWorkspaceInvitationDeliveryStore } from './invitations/delivery.js';
export type {
  WorkspaceInvitationDeliveryClaim,
  WorkspaceInvitationDeliveryStore,
} from './invitations/delivery.js';

export {
  createAuthenticationMailDeliveryStore,
  createAuthenticationMailEnqueueStore,
} from '../identity/authentication-mail.js';
export type {
  AuthenticationMailDeliveryClaim,
  AuthenticationMailDeliveryStore,
  AuthenticationMailEnqueueStore,
  AuthenticationMailInput,
  AuthenticationMailPurpose,
  SealedAuthenticationMailPayload,
} from '../identity/authentication-mail.js';

export {
  changePasswordAndRevokeSessions,
  setupPasswordAndRevokeSessions,
  resetPasswordAndRevokeSessions,
  unlinkMethodAndRevokeSessions,
} from '../identity/account-security.js';

export { AccountLinkingCommands } from '../identity/account-linking.js';

export { EmailProofCommands } from '../identity/email-proofs.js';
