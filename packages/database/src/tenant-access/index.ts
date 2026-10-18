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
  hasCredentialAccount,
  changePasswordAndRevokeSessions,
  setupPasswordAndRevokeSessions,
  resetPasswordAndRevokeSessions,
  unlinkMethodAndRevokeSessions,
} from '../identity/account-security.js';

export { AccountLinkingCommands } from '../identity/account-linking.js';
export { SocialSignInCommands } from '../identity/federation/sign-in.js';

export { EmailProofCommands } from '../identity/email-proofs.js';

export { createApiTokenDatabase } from './tokens/store.js';
export { ApiTokenPolicyError } from './tokens/types.js';
export type {
  ApiTokenDatabase,
  VerifiedApiToken,
  ApiTokenOwner,
  ApiTokenCommand,
} from './tokens/types.js';
export { parseApiTokenCredential } from './tokens/credential.js';
export type { ParsedApiTokenCredential } from './tokens/credential.js';

export {
  createFederationManagementStore,
  type FederationManagementStore,
} from '../identity/federation/management/store.js';
export { FederationConflictError } from '../identity/federation/management/contract.js';

export {
  isAuthenticationSessionAllowed,
  isIdentityEmailChangeAllowed,
  authorizeCredentialSignIn,
} from '../identity/federation/sessions/authority.js';

export { OrganizationSignInCommands } from '../identity/federation/journeys/store.js';
