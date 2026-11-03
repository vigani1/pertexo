// OpenAPI documents and client contracts, projected from the schemas when
// imported. The API serves them and `contracts:generate` writes them out.
export { artifactTransferOpenApiDocument } from './openapi/execution/artifact-transfer.js';
export { CONTRACT_ARTIFACTS } from './openapi/generated-artifacts.js';
export { publicOpenApiDocument } from './openapi/public.js';
export { catalogOpenApiDocument } from './openapi/catalog.js';
export { connectionsOpenApiDocument } from './openapi/connections.js';
export { identityWorkspaceOpenApiDocument } from './openapi/identity/workspaces.js';
export { nodeTestingOpenApiDocument } from './openapi/execution/node-testing.js';
export { schedulesOpenApiDocument } from './openapi/triggers/schedules.js';
export { webhooksOpenApiDocument } from './openapi/triggers/webhooks.js';
export { workflowAuthoringOpenApiDocument } from './openapi/workflows/authoring.js';
export { workflowPortabilityOpenApiDocument } from './openapi/workflows/portability.js';
export { workflowRunsOpenApiDocument } from './openapi/execution/runs.js';
export { workspaceInboxOpenApiDocument } from './openapi/identity/inbox.js';
export type {
  AnyRoute,
  RouteCapability,
  RouteDeclaration,
  RouteInput,
} from './routes/define.js';
export { catalogRoutes } from './routes/catalog.js';
export { scheduleRoutes } from './routes/triggers/schedules.js';
export { artifactRoutes } from './routes/execution/artifacts.js';
export { workflowRunRoutes } from './routes/execution/runs.js';
export { pendingTaskRoutes } from './routes/execution/pending-tasks.js';
export { formRoutes } from './routes/forms/forms.js';
export { formUploadRoutes } from './routes/forms/uploads.js';
export { workflowRunDataRoutes } from './routes/execution/run-data.js';
export { usageRoutes } from './routes/execution/usage.js';
export { connectionRoutes } from './routes/connections/management.js';
export { failureNotificationRoutes } from './routes/connections/failure-notifications.js';
export {
  nodeTestingRoutes,
  stepSampleRoutes,
} from './routes/execution/node-testing.js';
export {
  workflowTestRoutes,
  workflowTestSuiteRoutes,
} from './routes/execution/draft-tests.js';
export { notificationPreferenceRoutes } from './routes/identity/notification-preferences.js';
export { inboxRoutes } from './routes/identity/inbox.js';
export { webhookRoutes } from './routes/triggers/webhooks.js';
export { dataTableRoutes } from './routes/identity/data-tables.js';
export { variableRoutes } from './routes/identity/variables.js';
export { apiTokenRoutes } from './routes/identity/api-tokens.js';
export { governanceRoutes } from './routes/identity/governance.js';
export { workspaceRoutes } from './routes/identity/workspaces.js';
export { invitationRoutes } from './routes/identity/invitations.js';
export { workflowSettingsRoutes } from './routes/workflows/settings.js';
export { inputCaseRoutes } from './routes/workflows/input-cases.js';
export { publicationReviewRoutes } from './routes/workflows/reviews.js';
export { promotionRoutes } from './routes/workflows/promotions.js';

export { authoringRoutes } from './routes/workflows/authoring.js';

export { lifecycleRoutes } from './routes/workflows/lifecycle.js';

export { versionRoutes } from './routes/workflows/versions.js';
