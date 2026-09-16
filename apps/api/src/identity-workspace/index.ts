export { IdentityWorkspaceModule } from './module.js';
export { OidcController, SessionController } from './auth-controllers.js';
export {
  UserController,
  WorkspaceDiscoveryController,
  WorkspaceMembersController,
  WorkspaceController,
} from './controllers.js';
export {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  WorkspaceManageGuard,
  authenticatedSession,
  readHeader,
} from './guards.js';
export {
  CreateWorkspaceUseCase,
  ChangeWorkspaceMemberRoleUseCase,
  GetCurrentUserUseCase,
  ListAccessibleWorkspacesUseCase,
  ListWorkspaceMembersUseCase,
  OidcApplicationService,
  WorkspaceLifecycleUseCase,
} from './use-cases.js';
export { DatabaseIdentityWorkspaceAdapter } from './database-adapter.js';
export { mapIdentityWorkspaceError } from './errors.js';
export * from './ports.js';
export * from './tokens.js';
export * from './types.js';
export { requestIdentifier, traceIdentifier } from './request-identifiers.js';
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
