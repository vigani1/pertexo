export { IdentityWorkspaceModule } from './module.js';
export {
  OidcController,
  SessionController,
  WorkspaceController,
} from './controllers.js';
export {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  WorkspaceCapabilityGuard,
  WorkspaceManageGuard,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  OIDC_BROWSER_BINDING_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  authenticatedSession,
  readCookie,
  readHeader,
} from './guards.js';
export {
  CreateWorkspaceUseCase,
  OidcApplicationService,
  WorkspaceLifecycleUseCase,
  type CreateWorkspaceInput,
  type OidcLoginPort,
  type RequestDeletionInput,
  type SessionIssuePort,
  type WorkspaceLifecycleInput,
} from './use-cases.js';
export {
  DatabaseIdentityWorkspaceAdapter,
  asSessionStore,
} from './database-adapter.js';
export {
  mapIdentityWorkspaceError,
  workspaceApplicationError,
} from './errors.js';
export * from './ports.js';
export * from './tokens.js';
export * from './types.js';
export { requestIdentifier, traceIdentifier } from './request-identifiers.js';
export {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from './contracts.js';
export {
  createIdentityWorkspaceTelemetry,
  IDENTITY_WORKSPACE_METRIC_NAME,
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
} from './telemetry.js';
export type {
  IdentityWorkspaceCounter,
  IdentityWorkspaceHistogram,
  IdentityWorkspaceMeter,
  IdentityWorkspaceMetricAttributes,
  IdentityWorkspaceOperation,
  IdentityWorkspaceOutcome,
  IdentityWorkspaceSpan,
  IdentityWorkspaceTelemetry,
  IdentityWorkspaceTelemetryOptions,
  IdentityWorkspaceTracer,
} from './telemetry.js';
