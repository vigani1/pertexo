export type { Role } from '@pertexo/workflow-model';
export { createIdentityWorkspaceDatabase } from './repository.js';
export {
  IdentityConflictError,
  IdentityNotFoundError,
  WorkspaceAccessDeniedError,
  WorkspaceLifecycleConflictError,
  WorkspaceMemberRoleCommandConflictError,
  WorkspaceMemberRemovalCommandConflictError,
  WorkspaceMembershipCommandConflictError,
  WorkspaceRenameCommandConflictError,
  UserProfileCommandConflictError,
} from './errors.js';
export { USER_STATUS, WORKSPACE_STATUS } from './state.js';
export type {
  CreateUserInput,
  IdentityWorkspaceDatabase,
  RequestWorkspaceLifecycleOperationInput,
  UserStatus,
  UserRecord,
  WorkspaceAccessRecord,
  WorkspaceMemberRecord,
  WorkspaceMembersPage,
  WorkspaceLifecycleOperation,
  WorkspaceRecord,
  WorkspaceStatus,
  WorkspaceWithOwnerInput,
} from './contract.js';
export type {
  IdentityConflictReason,
  WorkspaceLifecycleConflictReason,
  WorkspaceMemberRoleCommandConflictReason,
  WorkspaceRenameCommandConflictReason,
} from './errors.js';
export {
  parseWorkspaceId,
  withActorScopedClient,
  withTenantScopedReadClient,
  withTenantScopedClient,
  withWorkspaceReadTransaction,
  withWorkspaceTransaction,
  type WorkspaceTransactionOptions,
} from '@pertexo/database/primitives';
export { withPlatformTransaction } from '@pertexo/database/platform';
export type {
  WorkspaceDrizzle,
  WorkspaceId,
  WorkspaceTransaction,
} from '@pertexo/database/primitives';
