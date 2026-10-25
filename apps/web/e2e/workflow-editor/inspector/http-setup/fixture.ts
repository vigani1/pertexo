import { workflowDraftResponseSchema } from '@pertexo/contracts';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../../packages/node-catalog/dist/index.js';
import type { Page } from '../../../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  user,
  workflowId,
  workspace,
  workspaceId,
  type RemoteDraft,
} from '../../support';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const httpDefinition =
  platformBrowserNodeDefinitionCatalog().definitions.find(
    ({ definition }) =>
      definition.key === 'http.request' && definition.version === 1,
  );

export function httpDraft(maxResponseBytes = 1_048_576) {
  return remoteDraft({
    nodes: [
      {
        id: 'http',
        label: 'Fetch status',
        definition: { key: 'http.request', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {
          method: 'GET',
          url: 'https://api.example.test/status',
          headers: { 'X-Trace': 'preserved' },
          timeoutMillis: 10_000,
          maxRedirects: 3,
          maxResponseBytes,
          inlineResponseBytes: 65_536,
        },
        inputMappings: {},
        connectionRefs: { http_headers: connectionId },
      },
    ],
    edges: [],
    settings: {},
  });
}

export function savedHttpNode(remote: RemoteDraft) {
  const draft = workflowDraftResponseSchema.parse({
    workflowId,
    revision: remote.revision,
    graph: remote.graph,
    compatibility: {
      compatible: true,
      fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
      issues: [],
    },
    updatedAt: user.updatedAt,
  });
  const node = draft.graph.nodes.find(({ id }) => id === 'http');
  if (node === undefined) throw new Error('HTTP step must remain in the draft');
  return node;
}

export function savedConfig(remote: RemoteDraft) {
  return savedHttpNode(remote).config;
}

export async function openSetup(page: Page, width: number) {
  await page.getByTestId('rf__node-http').click();
  if (width < 1024)
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
}

export async function installHttp(
  page: Page,
  remote: RemoteDraft,
  editable = true,
) {
  await installEditorRoutes(page, remote, {
    definitions: [httpDefinition],
    accessibleWorkspace: {
      ...workspace,
      role: editable ? 'owner' : 'viewer',
      capabilities: editable
        ? [...workspace.capabilities, 'connection:use', 'connection:manage']
        : ['workspace:read', 'workflow:read', 'run:read', 'connection:read'],
    },
  });
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: connectionId,
            workspaceId,
            providerKey: 'http',
            name: 'Status API',
            authType: 'http_headers',
            status: 'active',
            secretVersionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            health: {
              lastTestedAt: null,
              lastHealthyAt: null,
              lastErrorCode: null,
            },
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
        ],
        nextCursor: null,
      },
    }),
  );
}
