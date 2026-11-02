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
  createIdentityWorkspaceStore,
  type IdentityWorkspaceStore,
} from './store.js';
export { WorkspaceAccessDeniedError } from '../shared/errors.js';
export {
  IdentityConflictError,
  InvitationAcceptanceConflictError,
  UserProfileCommandConflictError,
  WorkspaceInvitationCommandConflictError,
  WorkspaceLifecycleConflictError,
  WorkspaceMemberRemovalCommandConflictError,
  WorkspaceMemberRoleCommandConflictError,
  WorkspaceMembershipCommandConflictError,
  WorkspaceRenameCommandConflictError,
} from './errors.js';
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
} from './contract.js';
export type {
  WorkspaceMemberRemovalCommandConflictReason,
  WorkspaceMemberRoleCommandConflictReason,
  WorkspaceMembershipCommandConflictReason,
} from './errors.js';
export {
  createWorkspaceInvitationDeliveryStore,
  type WorkspaceInvitationDeliveryStore,
} from './invitations/delivery/store.js';
export type { WorkspaceInvitationDeliveryClaim } from './invitations/delivery/contract.js';

export { createApiTokenStore, type ApiTokenStore } from './tokens/store.js';
export { ApiTokenPolicyError } from './tokens/errors.js';
export type {
  VerifiedApiToken,
  ApiTokenOwner,
  ApiTokenCommand,
} from './tokens/contract.js';
export { parseApiTokenCredential } from './tokens/credential.js';
export type { ParsedApiTokenCredential } from './tokens/credential.js';

export { DirectoryManagedMembershipError } from './errors.js';

// Other areas import these files directly (ADR 091); the door gains nothing.
export type {} from './errors.js';
export type {} from './members/contract.js';
export type {} from './members/discovery.queries.js';
export type {} from './members/records.repository.js';
export type {} from './resources/authority.js';
export type {} from './resources/bindings.queries.js';
export type {} from './resources/connections/bindings.queries.js';
export type {} from './resources/connections/scope.js';
export type {} from './resources/principals.queries.js';
export type {} from './resources/revocation.repository.js';
export type {} from './resources/workflows.queries.js';
export type {} from './users/contract.js';
export type {} from './users/sessions.repository.js';
