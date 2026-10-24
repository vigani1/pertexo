export type { Role, DelegatedRole } from '@pertexo/workflow-model';
export {
  AUTHORIZATION_CAPABILITIES,
  capabilitiesForRole,
  hasCapability,
  ROLES,
  rolesForCapability,
} from '@pertexo/workflow-model';
export type { AuthorizationCapability } from '@pertexo/workflow-model';
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
} from './repository.js';
export type {
  AccessibleWorkspaceRecord,
  AccessibleWorkspacesPage,
  ChangeWorkspaceInvitationInput,
  ChangeWorkspaceMemberRoleInput,
  CompleteInvitationAcceptanceInput,
  CreateWorkspaceInvitationInput,
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
} from './repository.js';
export { createWorkspaceInvitationDeliveryStore } from './invitations/delivery.repository.js';
export type {
  WorkspaceInvitationDeliveryClaim,
  WorkspaceInvitationDeliveryStore,
} from './invitations/delivery.repository.js';

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

export { createApiTokenDatabase } from './tokens/repository.js';
export { ApiTokenPolicyError } from './tokens/contract.js';
export type {
  ApiTokenDatabase,
  VerifiedApiToken,
  ApiTokenOwner,
  ApiTokenCommand,
} from './tokens/contract.js';
export { parseApiTokenCredential } from './tokens/credential.js';
export type { ParsedApiTokenCredential } from './tokens/credential.js';

export {
  createFederationManagementStore,
  type FederationManagementStore,
} from '../identity/federation/management/store.js';
export { FederationConflictError } from '../identity/federation/management/contract.js';

export {
  identityEmailChangeEligibility,
  authorizeCredentialSignIn,
} from '../identity/federation/sessions/authority.js';

export { OrganizationSignInCommands } from '../identity/federation/journeys/store.js';

export { DirectoryError } from '../identity/federation/provisioning/contract.js';
export type {
  DirectoryPrincipal,
  DirectoryUserValues,
  DirectoryUserProfile,
  DirectoryGroupValues,
  DirectoryRole,
} from '../identity/federation/provisioning/contract.js';
export type { DirectoryUser } from '../identity/federation/provisioning/resources/users.js';
export type { DirectoryGroup } from '../identity/federation/provisioning/resources/groups.js';
export { DIRECTORY_LIMITS } from '../identity/federation/provisioning/limits.js';

export {
  createDirectoryStore,
  type DirectoryStore,
} from '../identity/federation/provisioning/store.js';
export type { DirectoryQuery } from '../identity/federation/provisioning/resources/queries.js';

export { DirectoryManagedMembershipError } from './errors.js';

export { isAuthenticationSessionAllowed } from '../identity/federation/sessions/lookup.js';

export { createTwoFactorRecoveryStore } from '../identity/two-factor/recovery.js';
export { recordIdentitySecurityFact } from '../identity/security-facts.js';
export type {
  TwoFactorRecoveryStore,
  TwoFactorRecoveryResult,
} from '../identity/two-factor/recovery.js';
