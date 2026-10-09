import { expect, test } from '@playwright/test';
import { platformBrowserNodeDefinitionCatalog } from '../../../packages/node-catalog/dist/index.js';
import {
  nodeDefinitionListResponseSchema,
  workflowDraftResponseSchema,
  workflowVersionResponseSchema,
  type WorkflowVersionResponse,
} from '@pertexo/contracts';
import { authorWebhookHttpGraph } from '../e2e-live/support/webhook-http-authoring';
import {
  addCsrfCookie,
  currentEtag,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  user,
  workflowId,
  workflowSummary,
  workspace,
  workspaceId,
} from './workflow-editor-support';

test('authors, reloads and publishes the complete real-pin webhook HTTP recipe through ordinary controls', async ({
  context,
  page,
}) => {
  // This catalog is loaded in the Node test process, never the client bundle.
  const realCatalog = platformBrowserNodeDefinitionCatalog();
  const keys = [
    'core.webhook',
    'core.validate',
    'core.set',
    'core.condition',
    'http.request',
  ];
  const catalog = nodeDefinitionListResponseSchema.parse({
    schemaVersion: 1,
    items: realCatalog.definitions.filter(
      ({ definition }) =>
        keys.includes(definition.key) && definition.version === 1,
    ),
  });
  expect(catalog.items).toHaveLength(5);
  const remote = remoteDraft();
  const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  let publishedVersion: WorkflowVersionResponse | undefined;
  let publishCommands = 0;
  await addCsrfCookie(context);
  // No page.request/Node API calls: every browser HTTP request is fail-closed.
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installEditorRoutes(page, remote, {
    accessibleWorkspace: {
      ...workspace,
      capabilities: [...workspace.capabilities, 'connection:use'],
    },
    definitions: catalog.items,
  });
  await page.route('**/v1/node-definitions', (route) =>
    route.fulfill({ json: catalog }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: connectionId,
            workspaceId,
            providerKey: 'http',
            name: 'Owned HTTP credential',
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
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) =>
      route.fulfill({
        json: workflowSummary(
          'Signed HTTP proof',
          publishedVersion?.id ?? null,
        ),
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
    (route) =>
      route.fulfill({
        json: {
          items: publishedVersion === undefined ? [] : [publishedVersion],
          nextCursor: null,
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
    (route) => {
      expect(route.request().headers()['if-match']).toBe(currentEtag(remote));
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      publishCommands += 1;
      publishedVersion = workflowVersionResponseSchema.parse({
        id: versionId,
        workflowId,
        versionNumber: 1,
        schemaVersion: 1,
        graph: structuredClone(remote.graph),
        checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
        publishedAt: user.updatedAt,
      });
      return route.fulfill({
        json: {
          version: publishedVersion,
          reused: false,
        },
      });
    },
  );
  await page.goto(editorUrl);
  const workflowPath = `/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
  const authored = await authorWebhookHttpGraph(page, workflowPath, () =>
    Promise.resolve(
      workflowDraftResponseSchema.parse({
        workflowId,
        revision: remote.revision,
        schemaVersion: 1,
        graph: remote.graph,
        compatibility: {
          compatible: true,
          fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
          issues: [],
        },
        updatedAt: user.updatedAt,
      }),
    ),
  );
  const graph = authored.graph;
  expect(graph.nodes.map(({ definition }) => definition.key).sort()).toEqual(
    keys.sort(),
  );
  expect(graph.nodes.find(({ id }) => id === authored.httpId)).toMatchObject({
    config: {
      method: 'POST',
      url: 'https://pertexo-controlled-action.example.test/effect',
      timeoutMillis: 5000,
      maxRedirects: 0,
      maxResponseBytes: 4096,
      inlineResponseBytes: 4096,
    },
    connectionRefs: { http_headers: connectionId },
    inputMappings: { body: { kind: 'run_input', path: '$.body' } },
  });
  expect(
    graph.nodes.find(({ id }) => id === authored.validateId),
  ).toMatchObject({
    inputMappings: {
      execute: {
        kind: 'node_output',
        nodeId: authored.webhookId,
        path: '$.execute',
      },
    },
  });
  expect(graph.nodes.find(({ id }) => id === authored.mapId)).toMatchObject({
    inputMappings: { condition: { kind: 'run_input', path: '$.execute' } },
  });
  expect(
    graph.nodes.find(({ id }) => id === authored.conditionId),
  ).toMatchObject({
    inputMappings: {
      condition: {
        kind: 'node_output',
        nodeId: authored.mapId,
        path: '$.condition',
      },
    },
  });
  expect(graph.edges.map(({ source, target }) => ({ source, target }))).toEqual(
    [
      {
        source: { nodeId: authored.webhookId, port: 'out' },
        target: { nodeId: authored.validateId, port: 'in' },
      },
      {
        source: { nodeId: authored.validateId, port: 'out' },
        target: { nodeId: authored.mapId, port: 'in' },
      },
      {
        source: { nodeId: authored.mapId, port: 'out' },
        target: { nodeId: authored.conditionId, port: 'in' },
      },
      {
        source: { nodeId: authored.conditionId, port: 'true' },
        target: { nodeId: authored.httpId, port: 'in' },
      },
    ],
  );
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Signed HTTP proof', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  expect(remote.graph).toEqual(graph);
  await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Publish v1', exact: true })
    .getByRole('button', { name: 'Publish v1', exact: true })
    .click();
  await expect(page.getByText('v1 is live', { exact: true })).toBeVisible();
  expect(publishCommands).toBe(1);
  expect(publishedVersion?.graph).toEqual(graph);
});
