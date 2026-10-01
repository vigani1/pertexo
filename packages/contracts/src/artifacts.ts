import {
  connectionsClientContract,
  connectionsOpenApiDocument,
} from './connections.js';
import { catalogClientContract, catalogOpenApiDocument } from './catalog.js';
import {
  artifactTransferClientContract,
  artifactTransferOpenApiDocument,
} from './artifact-transfer.js';
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
  workflowPortabilityClientContract,
  workflowPortabilityOpenApiDocument,
} from './workflow-portability.js';
import {
  workflowRunsClientContract,
  workflowRunsOpenApiDocument,
} from './workflow-runs.js';
import { webhooksClientContract, webhooksOpenApiDocument } from './webhooks.js';
import {
  schedulesClientContract,
  schedulesOpenApiDocument,
} from './schedules.js';
import {
  workspaceInboxClientContract,
  workspaceInboxOpenApiDocument,
} from './workspace-inbox.js';

const CONTRACT_DOMAINS = Object.freeze([
  ['catalog', catalogClientContract, catalogOpenApiDocument],
  [
    'artifacts',
    artifactTransferClientContract,
    artifactTransferOpenApiDocument,
  ],
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
  [
    'workflow-portability',
    workflowPortabilityClientContract,
    workflowPortabilityOpenApiDocument,
  ],
  ['schedules', schedulesClientContract, schedulesOpenApiDocument],
  ['webhooks', webhooksClientContract, webhooksOpenApiDocument],
  [
    'workspace-inbox',
    workspaceInboxClientContract,
    workspaceInboxOpenApiDocument,
  ],
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
