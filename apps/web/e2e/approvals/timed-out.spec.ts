import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '../support/fixtures';
import { approvalConfigSchema } from '@pertexo/workflow-model';
import { platformBrowserNodeDefinitionCatalog } from '../../../../packages/node-catalog/dist/index.js';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../workflow-editor/support';

const definitions = platformBrowserNodeDefinitionCatalog().definitions;
// Set to capture the reviewed screenshots of every size and theme.
const shots = process.env.PERTEXO_FEATURE_SHOTS;

function step(id: string, key: string, x: number, y: number) {
  return {
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    position: { x, y },
  };
}

function approvalDraft(onExpiry: 'fail' | 'continue', linked: boolean) {
  return remoteDraft({
    nodes: [
      step('start', 'core.manual', 0, 120),
      {
        ...step('review', 'core.approval', 300, 120),
        label: 'Manager approval',
        config: approvalConfigSchema.parse({ onExpiry }),
      },
      { ...step('ship', 'core.set', 640, 0), label: 'Ship order' },
      { ...step('refund', 'core.set', 640, 160), label: 'Refund' },
      { ...step('escalate', 'core.set', 640, 320), label: 'Escalate' },
    ],
    edges: [
      {
        id: 'start-review',
        source: { nodeId: 'start', port: 'out' },
        target: { nodeId: 'review', port: 'in' },
      },
      {
        id: 'review-ship',
        source: { nodeId: 'review', port: 'approved' },
        target: { nodeId: 'ship', port: 'in' },
      },
      {
        id: 'review-refund',
        source: { nodeId: 'review', port: 'rejected' },
        target: { nodeId: 'refund', port: 'in' },
      },
      ...(linked
        ? [
            {
              id: 'review-escalate',
              source: { nodeId: 'review', port: 'timed_out' },
              target: { nodeId: 'escalate', port: 'in' },
            },
          ]
        : []),
    ],
    settings: {},
  });
}

async function openStep(page: Page, width: number) {
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-review').click();
  if (width < 1024)
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
}

function timedOutHandle(page: Page) {
  return page.getByRole('img', {
    name: 'Manager approval: output Timed out',
    exact: true,
  });
}

test('chooses the Timed out path from the setup and draws its port only then', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const remote = approvalDraft('fail', false);
  await installEditorRoutes(page, remote, { definitions });
  await addCsrfCookie(context);
  await openStep(page, 1440);
  await expect(page.getByText('then fails the step')).toBeVisible();
  await expect(timedOutHandle(page)).toHaveCount(0);
  await page.getByText('Continue on Timed out', { exact: true }).click();
  await expect
    .poll(() => JSON.stringify(remote.graph.nodes))
    .toContain('"onExpiry":"continue"');
  await expect(timedOutHandle(page)).toBeVisible();
  await expect(page.getByText('then continues on Timed out')).toBeVisible();
  await page.getByText('Fail the step', { exact: true }).click();
  await expect
    .poll(() => JSON.stringify(remote.graph.nodes))
    .toContain('"onExpiry":"fail"');
  await expect(timedOutHandle(page)).toHaveCount(0);
});

test('keeps a linked Timed out path until its link is removed', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installEditorRoutes(page, approvalDraft('continue', true), {
    definitions,
  });
  await addCsrfCookie(context);
  await openStep(page, 1440);
  await expect(timedOutHandle(page)).toBeVisible();
  await expect(
    page
      .getByRole('list', { name: 'Outputs' })
      .getByText('Timed out → Escalate'),
  ).toBeVisible();
  await expect(
    page.getByRole('radio', { name: /Fail the step/u }),
  ).toBeDisabled();
  await expect(
    page.getByText('Remove the Timed out link to fail the step instead.'),
  ).toBeVisible();
});

const taskId = '11111111-1111-4111-8111-111111111111';
const task = {
  id: taskId,
  workspaceId,
  workflowId,
  workflowName: 'Order approvals',
  workflowVersionId: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
  nodeId: 'review',
  nodeRunId: '44444444-4444-4444-8444-444444444444',
  iterationPath: [],
  kind: 'approval',
  title: 'Approve order #1042',
  instructions: 'Check stock before approving.',
  details: { Customer: 'Ada', Amount: 120 },
  audience: { roles: ['owner', 'admin'], memberIds: [] },
  onExpiry: 'continue',
  output: null,
  completedByName: null,
};

function pendingTask() {
  const now = Date.now();
  return {
    ...task,
    status: 'pending',
    createdAt: new Date(now - 5 * 86_400_000).toISOString(),
    expiresAt: new Date(now + 2 * 86_400_000 + 600_000).toISOString(),
    completedAt: null,
    canRespond: true,
    blockedReason: null,
  };
}

const timedOutTask = {
  ...task,
  status: 'expired',
  createdAt: '2026-10-15T08:00:00.000Z',
  expiresAt: '2026-10-22T08:00:00.000Z',
  completedAt: '2026-10-22T08:00:05.000Z',
  canRespond: false,
  blockedReason: 'expired',
};

test('shows a calm countdown while waiting and how long it waited once timed out', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installEditorRoutes(page, remoteDraft());
  let current: unknown = pendingTask();
  await page.route(`**/pending-tasks/${taskId}`, (route) =>
    route.fulfill({ json: { task: current } }),
  );
  await page.goto(`/w/${workspaceId}/approvals/${taskId}`);
  await expect(page.getByText('Expires in 2 days')).toBeVisible();
  current = timedOutTask;
  await page.reload();
  await expect(page.getByText('Timed out after 7 days')).toBeVisible();
  await expect(
    page.getByText(
      'Nobody responded in time, so the run continued on its Timed out path.',
    ),
  ).toBeVisible();
});

const sizes = [
  [360, 740],
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1440, 900],
  [1920, 1080],
] as const;

for (const theme of ['light', 'dark'] as const)
  for (const [width, height] of sizes)
    test(`captures the Timed out path at ${String(width)}×${String(height)} ${theme}`, async ({
      page,
      context,
    }) => {
      test.skip(shots === undefined, 'Screenshots are captured on request');
      const directory = shots ?? '';
      await mkdir(directory, { recursive: true });
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
      await installEditorRoutes(page, approvalDraft('continue', true), {
        definitions,
      });
      await addCsrfCookie(context);
      await openStep(page, width);
      await expect(page.getByText('then continues on Timed out')).toBeVisible();
      const name = `${String(width)}x${String(height)}-${theme}`;
      // The window and the choice, each in view in the Step panel.
      await page
        .getByText('Opens when the run reaches this step')
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${directory}/timeline-${name}.png` });
      await page
        .getByText('Continue on Timed out', { exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${directory}/choice-${name}.png` });
      if (width < 1024)
        await page
          .getByRole('navigation', { name: 'Editor panels' })
          .getByRole('button', { name: 'Canvas', exact: true })
          .click();
      await expect(timedOutHandle(page)).toBeVisible();
      await page.screenshot({ path: `${directory}/editor-${name}.png` });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.route(`**/pending-tasks/${taskId}`, (route) =>
        route.fulfill({ json: { task: timedOutTask } }),
      );
      await page.goto(`/w/${workspaceId}/approvals/${taskId}`);
      await expect(page.getByText('Timed out after 7 days')).toBeVisible();
      await page.screenshot({ path: `${directory}/request-${name}.png` });
      await page.unroute(`**/pending-tasks/${taskId}`);
      await page.route(`**/pending-tasks/${taskId}`, (route) =>
        route.fulfill({ json: { task: pendingTask() } }),
      );
      await page.reload();
      await expect(page.getByText('Expires in 2 days')).toBeVisible();
      await page.screenshot({ path: `${directory}/waiting-${name}.png` });
    });
