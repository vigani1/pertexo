// OpenAPI documents and client contracts, projected from the schemas when
// imported. The API serves them and `contracts:generate` writes them out.
export { artifactTransferOpenApiDocument } from './openapi/execution/artifact-transfer.js';
export { CONTRACT_ARTIFACTS } from './openapi/generated-artifacts.js';
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
export { variableRoutes } from './routes/identity/variables.js';
