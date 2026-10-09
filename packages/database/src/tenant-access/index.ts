export {
  AUTHORIZATION_CAPABILITIES,
  capabilitiesForRole,
  hasCapability,
  ROLES,
  rolesForCapability,
} from './workspace-policy.js';
export type { AuthorizationCapability, Role } from './workspace-policy.js';
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
} from './identity-workspace.js';
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
  SessionRecord,
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
} from './identity-workspace.js';
export { createOidcLoginTransactionStore } from './oidc-login-transactions.js';
export type {
  OidcLoginTransactionStore,
  OidcSecretEncryptionAdapter,
  SealedOidcSecret,
} from './oidc-login-transactions.js';
export { createWorkspaceInvitationDeliveryStore } from './workspace-invitation-delivery.js';
export type {
  WorkspaceInvitationDeliveryClaim,
  WorkspaceInvitationDeliveryStore,
} from './workspace-invitation-delivery.js';
