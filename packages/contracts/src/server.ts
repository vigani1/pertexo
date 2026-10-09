// OpenAPI documents and client contracts, projected from the schemas when
// imported. The API serves them and `contracts:generate` writes them out.
export {
  artifactTransferClientContract,
  artifactTransferOpenApiDocument,
} from './openapi/execution/artifact-transfer.js';
export { CONTRACT_ARTIFACTS } from './openapi/generated-artifacts.js';
export {
  catalogClientContract,
  catalogOpenApiDocument,
} from './openapi/catalog.js';
export {
  connectionsClientContract,
  connectionsOpenApiDocument,
} from './openapi/connections.js';
export {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from './openapi/identity/workspaces.js';
export {
  nodeTestingClientContract,
  nodeTestingOpenApiDocument,
} from './openapi/execution/node-testing.js';
export {
  schedulesClientContract,
  schedulesOpenApiDocument,
} from './openapi/triggers/schedules.js';
export {
  webhooksClientContract,
  webhooksOpenApiDocument,
} from './openapi/triggers/webhooks.js';
export {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from './openapi/workflows/authoring.js';
export {
  workflowPortabilityClientContract,
  workflowPortabilityOpenApiDocument,
} from './openapi/workflows/portability.js';
export {
  workflowRunsClientContract,
  workflowRunsOpenApiDocument,
} from './openapi/execution/runs.js';
export {
  workspaceInboxClientContract,
  workspaceInboxOpenApiDocument,
} from './openapi/identity/inbox.js';
