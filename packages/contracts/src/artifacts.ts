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
import { webhooksClientContract, webhooksOpenApiDocument } from './webhooks.js';
import {
  schedulesClientContract,
  schedulesOpenApiDocument,
} from './schedules.js';

const CONTRACT_DOMAINS = Object.freeze([
  ['connections', connectionsClientContract, connectionsOpenApiDocument],
  [
    'identity-workspace',
    identityWorkspaceClientContract,
    identityWorkspaceOpenApiDocument,
  ],
  ['node-testing', nodeTestingClientContract, nodeTestingOpenApiDocument],
  [
    'workflow-authoring',
    workflowAuthoringClientContract,
    workflowAuthoringOpenApiDocument,
  ],
  ['workflow-runs', workflowRunsClientContract, workflowRunsOpenApiDocument],
  ['schedules', schedulesClientContract, schedulesOpenApiDocument],
  ['webhooks', webhooksClientContract, webhooksOpenApiDocument],
] as const);

export const CONTRACT_ARTIFACTS = Object.freeze(
  CONTRACT_DOMAINS.flatMap(([domain, client, openapi]) => [
    Object.freeze({
      fileName: `${domain}.client-schema.json`,
      content: `${JSON.stringify(client, undefined, 2)}\n`,
    }),
    Object.freeze({
      fileName: `${domain}.openapi.json`,
      content: `${JSON.stringify(openapi, undefined, 2)}\n`,
    }),
  ]),
);
