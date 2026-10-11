import { expect, test, type Page } from '@playwright/test';
import { workflowDraftResponseSchema } from '@pertexo/contracts';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  user,
  workflowId,
  workspace,
  workspaceId,
  type RemoteDraft,
} from '../support';

const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const httpDefinition = platformBrowserNodeDefinitionCatalog().definitions.find(
  ({ definition }) =>
    definition.key === 'http.request' && definition.version === 1,
);
if (httpDefinition === undefined)
  throw new Error('HTTP definition is required');

function httpDraft(maxResponseBytes = 1_048_576) {
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

function savedConfig(remote: RemoteDraft) {
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
  return node.config;
}

async function openSetup(page: Page, width: number) {
  await page.getByTestId('rf__node-http').click();
  if (width < 1024)
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
}

async function installHttp(page: Page, remote: RemoteDraft, editable = true) {
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

for (const width of [390, 1280]) {
  test(`puts credentials first and saves human sizes without losing JSON settings at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const remote = httpDraft();
    await installHttp(page, remote);
    await page.goto(editorUrl);
    await openSetup(page, width);
    const picker = page.getByLabel('HTTP connection', { exact: true });
    await expect(picker).toContainText('Status API');
    const pickerBox = await picker.boundingBox();
    const methodBox = await page
      .getByLabel('Method', { exact: true })
      .boundingBox();
    if (pickerBox === null || methodBox === null)
      throw new Error('Setup controls must be visible');
    expect(pickerBox.y + pickerBox.height).toBeLessThan(methodBox.y);
    const response = page.getByLabel('Largest response (in megabytes)', {
      exact: true,
    });
    const inline = page.getByLabel('Store as a file above (in kilobytes)', {
      exact: true,
    });
    await expect(response).toHaveValue('1');
    await expect(inline).toHaveValue('64');
    await expect(page.getByText('That’s 1 MB. Up to 10 MB.')).toHaveCount(0);
    await response.fill('1.1');
    await expect(response).toBeFocused();
    await expect
      .poll(() => savedConfig(remote).maxResponseBytes)
      .toBe(1_153_434);
    await inline.fill('64.001');
    await expect
      .poll(() => savedConfig(remote).inlineResponseBytes)
      .toBe(65_537);
    expect(savedConfig(remote).headers).toEqual({ 'X-Trace': 'preserved' });
    await page.reload();
    await openSetup(page, width);
    await expect(response).toHaveValue('1.1');
    await expect(inline).toHaveValue('64.001');
    await page
      .getByRole('button', { name: 'Increase Largest response', exact: true })
      .click();
    await expect(response).toHaveValue('2.1');
    await expect
      .poll(() => savedConfig(remote).maxResponseBytes)
      .toBe(2_202_010);
    await response.fill('11');
    await response.press('Tab');
    await expect(
      page.getByText('Largest response can be at most 10 MB.'),
    ).toBeVisible();
    expect(savedConfig(remote).maxResponseBytes).toBe(2_202_010);
    await response.fill('10');
    await page
      .getByRole('button', { name: 'Increase Largest response', exact: true })
      .click();
    await expect(response).toHaveValue('10');
    await expect
      .poll(() => savedConfig(remote).maxResponseBytes)
      .toBe(10_485_760);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test(`preserves an odd byte count and readonly setup at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    const remote = httpDraft(1_048_577);
    await installHttp(page, remote, false);
    await page.goto(editorUrl);
    await openSetup(page, width);
    await expect(
      page.getByLabel('HTTP connection', { exact: true }),
    ).toBeDisabled();
    const response = page.getByLabel('Largest response (in megabytes)', {
      exact: true,
    });
    await expect(response).toHaveValue('1.000001');
    await expect(response).toBeDisabled();
    await expect(
      page.getByRole('button', {
        name: 'Increase Largest response',
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'New HTTP connection' }),
    ).toHaveCount(0);
    expect(savedConfig(remote).maxResponseBytes).toBe(1_048_577);
    expect(remote.revision).toBe(1);
  });
}
