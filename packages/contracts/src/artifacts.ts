import {
  connectionsClientContract,
  connectionsOpenApiDocument,
} from './connections.js';
import {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from './identity-workspace.js';
import {
  nodeTestingClientContract,
  nodeTestingOpenApiDocument,
} from './node-testing.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from './workflow-authoring.js';
import {
  workflowRunsClientContract,
  workflowRunsOpenApiDocument,
} from './workflow-runs.js';

export const CONTRACT_ARTIFACTS = Object.freeze([
  Object.freeze({
    fileName: 'connections.client-schema.json',
    content: `${JSON.stringify(connectionsClientContract, undefined, 2)}\n`,
  }),
  Object.freeze({
    fileName: 'connections.openapi.json',
    content: `${JSON.stringify(connectionsOpenApiDocument, undefined, 2)}\n`,
  }),
  Object.freeze({
    fileName: 'identity-workspace.client-schema.json',
    content: `${JSON.stringify(identityWorkspaceClientContract, undefined, 2)}\n`,
  }),
  Object.freeze({
    fileName: 'identity-workspace.openapi.json',
    content: `${JSON.stringify(identityWorkspaceOpenApiDocument, undefined, 2)}\n`,
  }),
  Object.freeze({
    fileName: 'node-testing.client-schema.json',
    content: `${JSON.stringify(nodeTestingClientContract, undefined, 2)}\n`,
  }),
  Object.freeze({
    fileName: 'node-testing.openapi.json',
    content: `${JSON.stringify(nodeTestingOpenApiDocument, undefined, 2)}\n`,
  }),
  Object.freeze({
    fileName: 'workflow-authoring.client-schema.json',
    content: `${JSON.stringify(workflowAuthoringClientContract, undefined, 2)}\n`,
  }),
  Object.freeze({
    fileName: 'workflow-authoring.openapi.json',
    content: `${JSON.stringify(workflowAuthoringOpenApiDocument, undefined, 2)}\n`,
  }),
  Object.freeze({
    fileName: 'workflow-runs.client-schema.json',
    content: `${JSON.stringify(workflowRunsClientContract, undefined, 2)}\n`,
  }),
  Object.freeze({
    fileName: 'workflow-runs.openapi.json',
    content: `${JSON.stringify(workflowRunsOpenApiDocument, undefined, 2)}\n`,
  }),
]);
