import { API_PROBLEM_MANIFEST } from '../errors/api-problem.js';
import {
  connectionsClientContract,
  connectionsOpenApiDocument,
} from './connections.js';
import { catalogClientContract, catalogOpenApiDocument } from './catalog.js';
import {
  artifactTransferClientContract,
  artifactTransferOpenApiDocument,
} from './execution/artifact-transfer.js';
import {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from './identity/workspaces.js';
import {
  nodeTestingClientContract,
  nodeTestingOpenApiDocument,
} from './execution/node-testing.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from './workflows/authoring.js';
import {
  workflowPortabilityClientContract,
  workflowPortabilityOpenApiDocument,
} from './workflows/portability.js';
import {
  workflowRunsClientContract,
  workflowRunsOpenApiDocument,
} from './execution/runs.js';
import {
  webhooksClientContract,
  webhooksOpenApiDocument,
} from './triggers/webhooks.js';
import {
  schedulesClientContract,
  schedulesOpenApiDocument,
} from './triggers/schedules.js';
import {
  workspaceInboxClientContract,
  workspaceInboxOpenApiDocument,
} from './identity/inbox.js';

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

function problemCatalog(): string {
  const rows = Object.entries(API_PROBLEM_MANIFEST)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(
      ([code, { status, title }]) =>
        `| \`${code}\` | ${String(status)} | ${title} |`,
    );
  return [
    '# API problem codes',
    '',
    'Generated from the problem manifest; run `pnpm contracts:generate`. Branch on the code, never on `detail`.',
    '',
    '| Code | Status | Title |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

export const CONTRACT_ARTIFACTS = Object.freeze([
  Object.freeze({
    fileName: 'problem-codes.md',
    content: problemCatalog(),
  }),
  ...CONTRACT_DOMAINS.flatMap(([domain, client, openapi]) => [
    Object.freeze({
      fileName: `${domain}.client-schema.json`,
      content: `${JSON.stringify(client, undefined, 2)}\n`,
    }),
    Object.freeze({
      fileName: `${domain}.openapi.json`,
      content: `${JSON.stringify(openapi, undefined, 2)}\n`,
    }),
  ]),
]);
