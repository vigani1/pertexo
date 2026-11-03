import { publicOpenApiDocument } from './public.js';
import { API_PROBLEM_MANIFEST } from '../errors/api-problem.js';
import { connectionsOpenApiDocument } from './connections.js';
import { catalogOpenApiDocument } from './catalog.js';
import { artifactTransferOpenApiDocument } from './execution/artifact-transfer.js';
import { identityWorkspaceOpenApiDocument } from './identity/workspaces.js';
import { nodeTestingOpenApiDocument } from './execution/node-testing.js';
import { workflowAuthoringOpenApiDocument } from './workflows/authoring.js';
import { workflowPortabilityOpenApiDocument } from './workflows/portability.js';
import { workflowRunsOpenApiDocument } from './execution/runs.js';
import { webhooksOpenApiDocument } from './triggers/webhooks.js';
import { schedulesOpenApiDocument } from './triggers/schedules.js';
import { workspaceInboxOpenApiDocument } from './identity/inbox.js';

const CONTRACT_DOMAINS = Object.freeze([
  ['catalog', catalogOpenApiDocument],
  ['artifacts', artifactTransferOpenApiDocument],
  ['connections', connectionsOpenApiDocument],
  ['identity-workspace', identityWorkspaceOpenApiDocument],
  ['node-testing', nodeTestingOpenApiDocument],
  ['workflow-authoring', workflowAuthoringOpenApiDocument],
  ['workflow-runs', workflowRunsOpenApiDocument],
  ['workflow-portability', workflowPortabilityOpenApiDocument],
  ['schedules', schedulesOpenApiDocument],
  ['webhooks', webhooksOpenApiDocument],
  ['workspace-inbox', workspaceInboxOpenApiDocument],
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
  Object.freeze({ fileName: 'problem-codes.md', content: problemCatalog() }),
  Object.freeze({
    fileName: 'public-api.openapi.json',
    content: `${JSON.stringify(publicOpenApiDocument, undefined, 2)}\n`,
  }),
  ...CONTRACT_DOMAINS.map(([domain, openapi]) =>
    Object.freeze({
      fileName: `${domain}.openapi.json`,
      content: `${JSON.stringify(openapi, undefined, 2)}\n`,
    }),
  ),
]);
