import { expect, test } from '../../support/fixtures';

import { addStep } from '../actions';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  runSummary,
  user,
  workspace,
  workspaceId,
} from '../support';

import {
  installNodeTestRoute,
  installPublishRoutes,
  routeVersions,
  runId,
  versionId,
} from './publish/fixture';

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
