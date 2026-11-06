export type { Role, DelegatedRole } from '@pertexo/policy';
export {
  AUTHORIZATION_CAPABILITIES,
  capabilitiesForRole,
  hasCapability,
  ROLES,
  rolesForCapability,
} from '@pertexo/policy';
export type { AuthorizationCapability } from '@pertexo/policy';
export {
  createIdentityWorkspaceStore,
  type IdentityWorkspaceStore,
} from './identity-workspace.store.js';
export { WorkspaceAccessDeniedError } from '../shared/workspace-access.errors.js';
export {
  IdentityConflictError,
  InvitationAcceptanceConflictError,
  UserProfileCommandConflictError,
  WorkspaceInvitationCommandConflictError,
  WorkspaceMemberRemovalCommandConflictError,
  WorkspaceMemberRoleCommandConflictError,
  WorkspaceMembershipCommandConflictError,
  WorkspaceRenameCommandConflictError,
} from './tenant-access.errors.js';
export type {
  AccessibleWorkspaceRecord,
  AccessibleWorkspacesPage,
  ChangeWorkspaceMemberRoleInput,
  CompleteInvitationAcceptanceInput,
  CreateWorkspaceInvitationInput,
  InvitationAcceptanceIntentRecord,
  InvitationAcceptanceResult,
  LeaveWorkspaceInput,
  RemoveWorkspaceMemberInput,
  RenameWorkspaceInput,
  ResendWorkspaceInvitationInput,
  RevokeWorkspaceInvitationInput,
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
  WorkspaceMemberRemovalResult,
  WorkspaceMemberRoleChangeResult,
  WorkspaceMembersPage,
  WorkspaceMemberStatusCommandInput,
  WorkspaceMemberStatusResult,
  WorkspaceOwnershipTransferResult,
  WorkspaceRenameResult,
} from './tenant-access.types.js';
export type {
  WorkspaceMemberRemovalCommandConflictReason,
  WorkspaceMemberRoleCommandConflictReason,
  WorkspaceMembershipCommandConflictReason,
} from './tenant-access.errors.js';
export {
  createWorkspaceInvitationDeliveryStore,
  type WorkspaceInvitationDeliveryStore,
} from './invitations/delivery/workspace-invitation-delivery.store.js';
export type { WorkspaceInvitationDeliveryClaim } from './invitations/delivery/invitation-delivery.types.js';

export {
  createApiTokenStore,
  type ApiTokenStore,
} from './tokens/api-token.store.js';
export { ApiTokenPolicyError } from './tokens/api-token.errors.js';
export type {
  VerifiedApiToken,
  ApiTokenOwner,
  ApiTokenCommand,
} from './tokens/api-token.types.js';
export { parseApiTokenCredential } from './tokens/credential.js';
export type { ParsedApiTokenCredential } from './tokens/credential.js';

export { DirectoryManagedMembershipError } from './tenant-access.errors.js';

// Other areas import these files directly (ADR 091); the door gains nothing.
export type {} from './tenant-access.errors.js';
export type {} from './members/membership.types.js';
export type {} from './members/discovery.repository.js';
export type {} from './members/records.repository.js';
export type {} from './resources/authority.js';
export type {} from './resources/bindings.repository.js';
export type {} from './resources/connections/bindings.repository.js';
export type {} from './resources/connections/scope.js';
export type {} from './resources/principals.repository.js';
export type {} from './resources/revocation.repository.js';
export type {} from './resources/workflows.repository.js';
export type {} from './users/authentication-replacement.types.js';
export type {} from './users/sessions.repository.js';
