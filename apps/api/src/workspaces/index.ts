export { IdentityWorkspaceModule } from './module.js';
export { SessionController } from './http/session-controller.js';
export {
  UserController,
  WorkspaceDiscoveryController,
  WorkspaceMembersController,
  WorkspaceController,
} from './http/controllers.js';
export {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  WorkspaceManageGuard,
  authenticatedSession,
  readHeader,
} from './http/guards.js';
export {
  CreateWorkspaceUseCase,
  ChangeWorkspaceMemberRoleUseCase,
  GetCurrentUserUseCase,
  ListAccessibleWorkspacesUseCase,
  ListWorkspaceMembersUseCase,
  WorkspaceLifecycleUseCase,
} from './use-cases.js';
export { DatabaseIdentityWorkspaceAdapter } from './persistence/database-adapter.js';
export { WorkspaceInvitationManagementUseCase } from './invitations/management.js';
export { InvitationAcceptanceController } from './invitations/acceptance-controller.js';
export { RemoveWorkspaceMemberUseCase } from './members/removal.js';
export { WorkspaceMembershipLifecycleUseCase } from './members/lifecycle.js';
export { WorkspaceMembershipController } from './members/lifecycle-controller.js';
export { UpdateUserProfileUseCase } from './commands/user-profile.js';
export { InvitationAcceptanceUseCase } from './invitations/acceptance.js';
export { RenameWorkspaceUseCase } from './commands/rename.js';
export { mapIdentityWorkspaceError } from './errors.js';
export * from './ports.js';
export * from './tokens.js';
export * from './types.js';
export { requestIdentifier, traceIdentifier } from './request/identifiers.js';
export { encodeWorkspaceMemberCursor } from './cursor.js';
export {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from './contracts.js';
export {
  createIdentityWorkspaceTelemetry,
  IDENTITY_WORKSPACE_METRIC_NAME,
  IDENTITY_WORKSPACE_OPERATION,
} from './telemetry.js';
export type {
  IdentityWorkspaceCounter,
  IdentityWorkspaceHistogram,
  IdentityWorkspaceMeter,
  IdentityWorkspaceSpan,
  IdentityWorkspaceTelemetry,
  IdentityWorkspaceTracer,
} from './telemetry.js';
