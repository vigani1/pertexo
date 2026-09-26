import { expect, test, type Page } from '@playwright/test';
import {
  addCsrfCookie,
  addStep,
  currentEtag,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  runSummary,
  user,
  workflowId,
  workspace,
  workspaceId,
  type Graph,
  type RemoteDraft,
} from './workflow-editor-support';

const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const previewId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const disclosure = {
  sideEffectClass: 'safe',
  mayContactProvider: false,
  mayCauseExternalSideEffect: false,
  dryRun: 'not_supported',
};

test('tests a step, publishes v1, and follows the exact accepted run', async ({
  context,
  page,
}) => {
  const remote = remoteDraft();
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await installNodeTestRoute(page, remote);
  await installPublishRoutes(page, remote);

  await page.goto(editorUrl);
  // No trigger is enabled in this catalog: the empty draft says what to add
  // instead of “No issues”, and Publish waits for a step.
  await expect(
    page.getByRole('heading', { name: 'No triggers are enabled here' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add a step to start' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish v1' })).toBeDisabled();
  // The chip opens the issues lens at the bottom of the editor, over the
  // canvas, instead of a popover under the command bar.
  await page.getByRole('button', { name: 'Add a step to start' }).click();
  const issues = page.getByRole('region', { name: 'Issues' });
  await expect(issues).toContainText('This draft has no steps yet');
  const issuesBox = await issues.boundingBox();
  expect((issuesBox?.y ?? 0) + (issuesBox?.height ?? 0)).toBeGreaterThan(
    (page.viewportSize()?.height ?? 0) - 48,
  );
  await issues.getByRole('button', { name: 'Close issues' }).click();
  await expect(issues).toBeHidden();
  await addStep(page, /Set fields/u).click();
  await expect.poll(() => remote.revision, { timeout: 4_000 }).toBe(2);
  await page.locator('.react-flow__node').click();
  await page.getByRole('tab', { name: 'Test' }).click();
  await page.getByRole('button', { name: 'Check setup' }).click();
  await expect(page.getByText('Setup looks right')).toBeVisible();
  // Set fields changes nothing outside Pertexo, so no acknowledgement.
  await expect(
    page.getByRole('switch', { name: 'I understand this test runs for real' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(
    page.getByRole('region', { name: 'Test result' }).getByText('Test passed'),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Last test' }).getByText('Test passed'),
  ).toBeVisible();
  await expect(page.getByRole('group', { name: 'Test output' })).toContainText(
    'accepted',
  );

  await expect(
    page.getByRole('button', { name: 'Run (publish first)' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Publish v1' }).click();
  const lens = page.getByRole('dialog', { name: 'Publish v1' });
  await lens.getByRole('button', { name: 'Publish v1' }).click();
  await expect(lens).toBeHidden();
  await expect(page.getByText('v1 is live')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish v2' })).toBeVisible();

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Run published version' }).click();
  await expect(page).toHaveURL(`/w/${workspaceId}/runs/${runId}`);
});

test('animates active execution flow and disables the marker for reduced motion', async ({
  page,
}) => {
  const graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: 'source-node',
        definition: { key: 'core.source', version: 1 },
        position: { x: 80, y: 120 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'target-node',
        definition: { key: 'core.target', version: 1 },
        position: { x: 420, y: 120 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'source-to-target',
        source: { nodeId: 'source-node', port: 'out' },
        target: { nodeId: 'target-node', port: 'in' },
      },
    ],
    settings: {},
  };
  const runningRun = {
    ...runSummary(runId, versionId, 'running'),
    completedAt: null,
  };
  await page.route('**/v1/users/me', (route) => route.fulfill({ json: user }));
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({ json: { items: [workspace], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs/${runId}`, (route) =>
    route.fulfill({
      json: {
        run: runningRun,
        nodes: [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            nodeId: 'target-node',
            invocationKey: 'target-node:1',
            status: 'running',
            currentAttemptNumber: 1,
            startedAt: '2026-09-14T10:02:02.000Z',
            completedAt: null,
            resumeAt: null,
            safeErrorCode: null,
          },
        ],
      },
    }),
  );
  await routeVersions(page, () => graph, 'c');
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${runId}/events`,
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `id: 1\nevent: node.started\ndata: ${JSON.stringify({
          sequence: 1,
          type: 'node.started',
          createdAt: '2026-09-14T10:02:02.000Z',
          payload: {
            schemaVersion: 1,
            nodeId: 'target-node',
            invocationKey: 'target-node:1',
          },
        })}\n\n`,
      }),
  );

  await page.goto(`/w/${workspaceId}/runs/${runId}`);
  await page.getByRole('tab', { name: 'Graph' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  const marker = page.locator('.workflow-transfer-marker');
  await expect(marker).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(marker).toBeHidden();
});

async function installNodeTestRoute(page: Page, remote: RemoteDraft) {
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/nodes/*/test`,
    async (route) => {
      const body = route.request().postDataJSON() as {
        mode: 'validate' | 'test_execute';
        expectedRevision: number;
      };
      expect(body.expectedRevision).toBe(remote.revision);
      const nodeId = firstNodeId(remote.graph);
      if (body.mode === 'validate') {
        await route.fulfill({
          json: {
            mode: 'validate',
            valid: true,
            revision: remote.revision,
            nodeId,
            issues: [],
            disclosure,
          },
        });
        return;
      }
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      await route.fulfill({
        status: 202,
        json: {
          mode: 'test_execute',
          replayed: false,
          preview: previewSummary(nodeId, remote.revision),
        },
      });
    },
  );
}

async function installPublishRoutes(page: Page, remote: RemoteDraft) {
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
    (route) => {
      expect(route.request().headers()['if-match']).toBe(currentEtag(remote));
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      return route.fulfill({
        json: { version: version(remote.graph, 'b'), reused: false },
      });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
    (route) => {
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      return route.fulfill({
        json: { run: runSummary(runId, versionId, 'queued'), replayed: false },
      });
    },
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs/${runId}`, (route) =>
    route.fulfill({
      json: { run: runSummary(runId, versionId, 'succeeded'), nodes: [] },
    }),
  );
  await routeVersions(page, () => remote.graph, 'b');
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${runId}/events`,
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `id: 1\nevent: run.succeeded\ndata: ${JSON.stringify({
          sequence: 1,
          type: 'run.succeeded',
          createdAt: '2026-09-14T10:03:00.000Z',
          payload: { schemaVersion: 1 },
        })}\n\n`,
      }),
  );
}

/** The published versions list, holding v1 of whatever graph is current. */
async function routeVersions(page: Page, graph: () => Graph, checksum: string) {
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
    (route) =>
      route.fulfill({
        json: { items: [version(graph(), checksum)], nextCursor: null },
      }),
  );
}

function version(graph: Graph, checksum: string) {
  return {
    id: versionId,
    workflowId,
    versionNumber: 1,
    schemaVersion: 1,
    graph,
    checksum: `wf:v1:sha256:${checksum.repeat(64)}`,
    publishedAt: '2026-09-14T10:02:00.000Z',
  };
}

function firstNodeId(graph: Graph): string {
  const node = graph.nodes[0];
  return typeof node === 'object' && node !== null
    ? String(Reflect.get(node, 'id'))
    : 'missing';
}

function previewSummary(nodeId: string, revision: number) {
  return {
    id: previewId,
    workspaceId,
    workflowId,
    draftRevision: revision,
    nodeId,
    status: 'succeeded',
    disclosure,
    output: { kind: 'inline', value: { accepted: true } },
    safeErrorCode: null,
    createdAt: '2026-09-14T10:01:00.000Z',
    startedAt: '2026-09-14T10:01:01.000Z',
    completedAt: '2026-09-14T10:01:02.000Z',
    expiresAt: '2026-09-14T11:01:02.000Z',
  };
}
