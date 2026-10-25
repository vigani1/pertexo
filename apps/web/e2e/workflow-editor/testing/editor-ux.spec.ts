import { mkdir } from 'node:fs/promises';
import {
  chooseTestAction,
  expect,
  test,
  type Page,
  type Locator,
} from '../../support/fixtures';
import { createWorkflowNodeFixture } from '../../../test/support/fixtures/graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
  runSummary,
  user,
  workflowId,
  workspaceId,
} from '../support';
import {
  installPublishRoutes,
  runId,
  versionId,
} from '../publishing/publish/fixture';

const shots = process.env.EDITOR_UX_SHOTS;
const baseline = process.env.EDITOR_UX_BASELINE === '1';
const sizes = [
  [390, 844],
  [360, 740],
  [768, 1024],
  [1024, 768],
  [1440, 900],
  [1920, 1080],
] as const;
for (const [width, height] of sizes)
  for (const theme of ['light', 'dark'] as const) {
    test(`editor UX at ${String(width)}x${String(height)} ${theme}`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await addCsrfCookie(context);
      const nodes = [
        createWorkflowNodeFixture({
          id: 'manual',
          definition: { key: 'core.manual', version: 1 },
          position: { x: 80, y: 80 },
        }),
        createWorkflowNodeFixture({
          id: 'code',
          definition: { key: 'core.code', version: 1 },
          position: { x: 380, y: 80 },
        }),
        createWorkflowNodeFixture({
          id: 'orphan',
          definition: { key: 'core.read_file', version: 1 },
          position: { x: 380, y: 280 },
        }),
      ];
      const remote = remoteDraft({
        nodes,
        edges: [
          {
            id: 'link',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'code', port: 'in' },
          },
        ],
        settings: {},
      });
      await installEditorRoutes(page, remote, {
        definitions: [
          manualDefinition,
          { ...manualDefinition, definition: { key: 'core.form', version: 1 } },
          { ...definition, definition: { key: 'core.code', version: 1 } },
          { ...definition, definition: { key: 'core.read_file', version: 1 } },
          definition,
        ],
      });
      await installPublishRoutes(page, remote);
      const summary = {
        runId,
        startedBy: user.id,
        draftRevision: 1,
        status: 'succeeded',
        createdAt: '2026-10-25T10:00:00.000Z',
        expiresAt: '2026-11-01T10:00:00.000Z',
      };
      const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/tests`;
      await page.route(root, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { items: [summary] } })
          : route.fulfill({ status: 202, json: { runId } }),
      );
      await page.route(`${root}/prepare`, (route) =>
        route.fulfill({
          json: { draftRevision: 1, samples: [], effectfulSteps: [] },
        }),
      );
      await page.route(`${root}/${runId}`, (route) =>
        route.fulfill({
          json: {
            ...summary,
            graph: remote.graph,
            dispositions: { manual: 'execute', code: 'execute' },
          },
        }),
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${runId}`,
        (route) =>
          route.fulfill({
            json: {
              run: runSummary(runId, versionId, 'succeeded'),
              nodes: ['manual', 'code'].map((nodeId, i) => ({
                id:
                  i === 0
                    ? '11111111-1111-4111-8111-111111111111'
                    : '22222222-2222-4222-8222-222222222222',
                nodeId,
                invocationKey: `${nodeId}:1`,
                status: 'succeeded',
                currentAttemptNumber: 1,
                startedAt: '2026-10-25T10:00:00.000Z',
                completedAt: '2026-10-25T10:00:01.000Z',
                resumeAt: null,
                safeErrorCode: null,
              })),
            },
          }),
      );
      await page.route('**/node-runs/*/output', (route) =>
        route.fulfill({
          json: {
            output: {
              kind: 'inline',
              value: { accepted: true, message: 'Workflow test output' },
            },
          },
        }),
      );
      await page.goto(editorUrl);
      await expect(page.locator('.react-flow__node')).toHaveCount(3);
      const shot = async (screen: string) => {
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (shots) {
          await mkdir(shots, { recursive: true });
          await page.screenshot({
            path: `${shots}/${String(width)}x${String(height)}-${theme}-${screen}.png`,
          });
        }
      };
      await openMobilePanel(page, 'Add step');
      await shot('palette');
      if (!baseline) {
        const description = page
          .getByRole('complementary', { name: 'Add a step', exact: true })
          .getByText('Start when someone submits a form', { exact: true });
        expect(
          await description.evaluate(
            (element) => element.scrollHeight <= element.clientHeight,
          ),
        ).toBe(true);
      }
      await openMobilePanel(page, 'Canvas');
      await chooseTestAction(page, 'Test workflow');
      const testDialog = page.getByRole('dialog', {
        name: 'Test workflow',
        exact: true,
      });
      await expect(
        testDialog.getByRole('button', { name: 'Start test', exact: true }),
      ).toBeEnabled();
      if (!baseline) {
        await expectFixedFooter(
          testDialog,
          'Start test',
          height,
          testDialog.getByLabel('Test input (JSON)', { exact: true }),
        );
      }
      await shot('test-confirmation');
      await testDialog
        .getByRole('button', { name: 'Start test', exact: true })
        .click();
      await expect(testDialog).toHaveCount(0);
      await page
        .getByRole('region', { name: 'Workflow tests', exact: true })
        .getByRole('button', { name: 'Close tests' })
        .click();
      await page
        .locator('.react-flow__node')
        .filter({ has: page.getByText('Code', { exact: true }) })
        .click();
      await openMobilePanel(page, 'Step');
      const panel = page.getByRole('complementary', { name: 'Step panel' });
      await panel.getByRole('tab', { name: 'Test', exact: true }).click();
      if (!baseline)
        await expect(
          panel.getByRole('region', { name: 'Latest workflow test' }),
        ).toContainText('Workflow test output');
      await shot('inspector-test');
      if (baseline) {
        await openMobilePanel(page, 'Canvas');
        await chooseTestAction(page, 'Test history');
      } else {
        await panel
          .getByRole('button', { name: 'View full test history', exact: true })
          .click();
      }
      const history = page.getByRole('region', {
        name: 'Workflow tests',
        exact: true,
      });
      await expect(history.getByRole('region').first()).toBeVisible();
      if (!baseline) await expect(history).toBeFocused();
      if (!baseline) {
        await expect(
          history.getByRole('region', {
            name: 'Test result: Manual start',
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          history.getByRole('region', {
            name: 'Test result: Code',
            exact: true,
          }),
        ).toBeVisible();
      }
      await history.getByText('View output', { exact: true }).last().click();
      await expect(history.getByText('Workflow test output')).toBeVisible();
      await history.getByText('Workflow test output').scrollIntoViewIfNeeded();
      await shot('history');
      if (!baseline) {
        const canvas = await bounds(page.locator('.react-flow'));
        const dock = await bounds(history);
        expect(canvas.y + canvas.height).toBeLessThanOrEqual(dock.y + 1);
      }
      await history.getByRole('button', { name: 'Close tests' }).click();
      const publish = page.getByRole('button', {
        name: 'Publish v1',
        exact: true,
      });
      if (!baseline)
        expect(
          await publish
            .locator('span:visible')
            .evaluateAll((labels) =>
              labels.every((label) => label.scrollWidth <= label.clientWidth),
            ),
        ).toBe(true);
      await publish.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveCSS('opacity', '1');
      if (!baseline) {
        await expect(
          dialog.getByRole('region', { name: 'Unconnected steps' }),
        ).toContainText("Read file isn't linked from a trigger");
        await expect(
          dialog.getByRole('button', { name: 'Publish v1', exact: true }),
        ).toBeEnabled();
        await expectFixedFooter(
          dialog,
          'Publish v1',
          height,
          dialog.getByText(
            'Runs already in progress finish on the version they started with.',
            { exact: true },
          ),
        );
        await dialog
          .getByRole('region', { name: 'Unconnected steps' })
          .scrollIntoViewIfNeeded();
      }
      await shot('publish');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await openMobilePanel(page, 'Add step');
      await page
        .getByRole('complementary', { name: 'Add a step', exact: true })
        .getByRole('button', { name: /Set fields/u })
        .click();
      await expect.poll(() => remote.graph.nodes.length).toBe(4);
      expect(remote.graph.edges.at(-1)).toMatchObject({
        source: { nodeId: 'code', port: 'out' },
      });
      await shot('added-step');
    });
  }

async function openMobilePanel(
  page: Page,
  name: 'Add step' | 'Canvas' | 'Step',
) {
  if ((page.viewportSize()?.width ?? 1280) >= 1024) return;
  await page
    .getByRole('navigation', { name: 'Editor panels' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('Expected the control to be visible');
  return box;
}
async function expectFixedFooter(
  dialog: Locator,
  action: string,
  height: number,
  reveal: Locator,
) {
  const button = dialog.getByRole('button', { name: action, exact: true });
  const before = await bounds(button);
  expect(before.y + before.height).toBeLessThanOrEqual(height);
  await reveal.scrollIntoViewIfNeeded();
  expect((await bounds(button)).y).toBe(before.y);
}
