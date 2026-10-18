import { expect, test, type Page } from '../support/fixtures';
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
  workflowSummary,
  type Graph,
  type RemoteDraft,
} from './support';

const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const previewId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const disclosure = {
  sideEffectClass: 'safe',
  mayContactProvider: false,
  mayCauseExternalSideEffect: false,
  dryRun: 'not_supported',
};

for (const width of [375, 1280]) {
  for (const action of ['menu', 'stamp'] as const) {
    test(`tests a step, publishes v1, and starts from ${action} at ${String(width)}px`, async ({
      context,
      page,
    }) => {
      await page.setViewportSize({ width, height: 768 });
      const remote = remoteDraft();
      await addCsrfCookie(context);
      await installEditorRoutes(page, remote);
      await page.route('**/v1/workspaces/*/workflows/*/presence?*', (route) =>
        route.fulfill({
          json: {
            people: [
              {
                userId: '12121212-1212-4212-8212-121212121212',
                displayName: 'Another editor',
                editing: true,
                dirty: false,
                baseRevision: 1,
                tabCount: 1,
              },
            ],
          },
        }),
      );
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
      await expect(
        page.getByRole('button', { name: 'Publish v1' }),
      ).toBeDisabled();
      // The chip opens the issues lens at the bottom of the editor, over the
      // canvas, instead of a popover under the command bar.
      await page.getByRole('button', { name: 'Add a step to start' }).click();
      const issues = page.getByRole('region', { name: 'Issues' });
      await expect(issues).toContainText('This draft has no steps yet');
      const issuesBox = await issues.boundingBox();
      const lowerBoundary =
        width < 1024
          ? (
              await page
                .getByRole('navigation', { name: 'Editor panels' })
                .boundingBox()
            )?.y
          : page.viewportSize()?.height;
      expect(lowerBoundary).toBeDefined();
      expect((issuesBox?.y ?? 0) + (issuesBox?.height ?? 0)).toBeGreaterThan(
        (lowerBoundary ?? 0) - 48,
      );
      await issues.getByRole('button', { name: 'Close issues' }).click();
      await expect(issues).toBeHidden();
      if (width < 1024) {
        await page
          .getByRole('navigation', { name: 'Editor panels' })
          .getByRole('button', { name: 'Add step', exact: true })
          .click();
      }
      await addStep(page, /Set fields/u).click();
      await expect.poll(() => remote.revision, { timeout: 4_000 }).toBe(2);
      if (width < 1024) {
        await page
          .getByRole('navigation', { name: 'Editor panels' })
          .getByRole('button', { name: 'Canvas', exact: true })
          .click();
      }
      await page.locator('.react-flow__node').click();
      if (width < 1024) {
        await page
          .getByRole('navigation', { name: 'Editor panels' })
          .getByRole('button', { name: 'Step', exact: true })
          .click();
      }
      await page.getByRole('tab', { name: 'Test' }).click();
      await page.getByRole('button', { name: 'Check setup' }).click();
      await expect(page.getByText('Setup looks right')).toBeVisible();
      // Set fields changes nothing outside Pertexo, so no acknowledgement.
      await expect(
        page.getByRole('switch', {
          name: 'I understand this test runs for real',
        }),
      ).toHaveCount(0);
      await page.getByRole('button', { name: 'Run test' }).click();
      await expect(
        page
          .getByRole('region', { name: 'Test result' })
          .getByText('Test passed'),
      ).toBeVisible();
      await expect(
        page
          .getByRole('region', { name: 'Last test' })
          .getByText('Test passed'),
      ).toBeVisible();
      await expect(
        page.getByRole('group', { name: 'Test output' }),
      ).toContainText('accepted');

      await expect(
        page.getByRole('button', { name: 'Run (publish first)' }),
      ).toBeDisabled();
      await page.getByRole('button', { name: 'Publish v1' }).click();
      const lens = page.getByRole('dialog', { name: 'Publish v1' });
      await lens.getByRole('button', { name: 'Publish v1' }).click();
      await expect(lens).toBeHidden();
      await expect(page.getByText('v1 is live')).toBeVisible();
      const published = page
        .getByRole('status')
        .filter({ hasText: 'v1 is live' });
      await expect
        .poll(
          async () => {
            const header = await page.locator('header').boundingBox();
            const feedback = await published.boundingBox();
            return (
              header !== null &&
              feedback !== null &&
              feedback.y >= header.y + header.height
            );
          },
          {
            timeout: 5000,
            message:
              'Publish feedback must leave all workflow header controls unobstructed',
          },
        )
        .toBe(true);
      await expect(
        page.getByRole('button', { name: 'No changes since v1' }),
      ).toBeDisabled();

      await page.screenshot({
        path: `/tmp/pertexo-245-${action}-${String(width)}.png`,
      });
      if (action === 'menu') {
        await page.getByRole('button', { name: 'Run', exact: true }).click();
        await page
          .getByRole('menuitem', { name: 'Run published version' })
          .click();
      } else {
        await page
          .getByRole('button', { name: 'Run now', exact: true })
          .click();
      }
      await expect(page).toHaveURL(`/w/${workspaceId}/runs/${runId}`);
      await expect(
        page.getByRole('dialog', { name: 'Run published version' }),
      ).toHaveCount(0);
    });
  }
}

test('animates active execution flow and disables the marker for reduced motion', async ({
  page,
}) => {
  const graph = {
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
    async (route) => {
      expect(route.request().headers()['if-match']).toBe(currentEtag(remote));
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      await page.route(
        `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
        (summaryRoute) =>
          summaryRoute.fulfill({
            json: workflowSummary('Customer onboarding', versionId),
          }),
      );
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
          payload: {},
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
    graph,
    checksum: `wf:sha256:${checksum.repeat(64)}`,
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

for (const width of [1280, 375])
  test(`publication names a missing variable and keeps the draft for retry at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const remote = remoteDraft();
    await addCsrfCookie(context);
    await installEditorRoutes(page, remote);
    await installPublishRoutes(page, remote);
    const keys: (string | undefined)[] = [];
    const name = width === 375 ? 'A'.repeat(64) : 'RATE';
    const message = `Workspace variable ${name} does not exist. Add it in Settings → Variables.`;
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
      (route) => {
        keys.push(route.request().headers()['idempotency-key']);
        if (keys.length > 1) return route.fallback();
        return route.fulfill({
          status: 422,
          contentType: 'application/problem+json',
          json: {
            type: 'urn:pertexo:problem:workflow.invalid',
            title: 'Invalid workflow',
            status: 422,
            code: 'workflow.invalid',
            requestId: 'variable-publish',
            errors: [
              {
                path: 'nodes.target.inputMappings.rate',
                code: 'invalid_mapping',
                message,
              },
            ],
          },
        });
      },
    );
    await page.goto(editorUrl);
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Add step', exact: true })
        .click();
    await addStep(page, /Set fields/u).click();
    await expect.poll(() => remote.revision).toBe(2);
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Canvas', exact: true })
        .click();
    const savedGraph = structuredClone(remote.graph);
    await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Publish v1',
      exact: true,
    });
    await dialog
      .getByRole('button', { name: 'Publish v1', exact: true })
      .click();
    await expect(dialog.getByText(message, { exact: true })).toBeVisible();
    expect(remote.graph).toEqual(savedGraph);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/pertexo-variable-publish-${String(width)}.png`,
    });
    await dialog
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('v1 is live', { exact: true })).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
    expect(remote.graph).toEqual(savedGraph);
  });
