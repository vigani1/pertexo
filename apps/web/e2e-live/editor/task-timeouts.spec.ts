import { createWorkflowNodeFixture } from '../../test/support/fixtures/graph';
import { readCsrfToken } from '../../test/support/browser/csrf';
import { mkdir } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { approvalConfigSchema } from '@pertexo/workflow-model';
import { pendingTaskListResponseSchema } from '@pertexo/contracts';
import { test } from '../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  publishSingleStep,
  startSingleStep,
  waitForRun,
  readEditorDraft,
} from '../support/authoring/single-step';

const screenshots = '/tmp/pertexo-task-timeout-screenshots';

type Graph = Awaited<ReturnType<typeof readEditorDraft>>['graph'];

/** Manual start → Approval → Approved / Rejected, each ending the run. */
function approvalGraph(): Graph {
  const end = (id: string, y: number) =>
    createWorkflowNodeFixture({
      id,
      label: id === 'approved' ? 'Ship order' : 'Refund',
      definition: { key: 'core.terminate', version: 1 },
      position: { x: 560, y },
    });
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      createWorkflowNodeFixture({
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 120 },
      }),
      {
        ...createWorkflowNodeFixture({
          id: 'approval',
          label: 'Manager approval',
          definition: { key: 'core.approval', version: 1 },
          position: { x: 280, y: 120 },
        }),
        config: approvalConfigSchema.parse({ title: 'Approve the order' }),
      },
      end('approved', 0),
      end('rejected', 240),
    ],
    edges: [
      {
        id: 'entry',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'approval', port: 'in' },
      },
      ...['approved', 'rejected'].map((port) => ({
        id: port,
        source: { nodeId: 'approval', port },
        target: { nodeId: port, port: 'in' },
      })),
    ],
  };
}

async function saveDraft(page: Page, workflowPath: string, graph: Graph) {
  const draft = await page.request.get(`${workflowPath}/draft`);
  expect(draft.status()).toBe(200);
  const saved = await page.request.put(`${workflowPath}/draft`, {
    headers: {
      'If-Match': draft.headers().etag ?? '',
      'x-csrf-token': await readCsrfToken(page),
    },
    data: { graph },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

/** Starts the published workflow and lets its open task reach expiry. */
async function runUntilExpiry(
  page: Page,
  input: Readonly<{ workspaceId: string; mailOrigin: string }>,
) {
  const runId = await startSingleStep(page, {});
  await waitForRun(page, input.workspaceId, runId, 'waiting');
  const expired = await page.request.post(`${input.mailOrigin}/task-expire`, {
    data: { workspaceId: input.workspaceId, runId },
  });
  expect(expired.status()).toBe(204);
  return runId;
}

async function openTask(page: Page, workspaceId: string, runId: string) {
  const response = await page.request.get(
    `/v1/workspaces/${workspaceId}/pending-tasks?view=all&status=all&runId=${runId}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  const task = pendingTaskListResponseSchema.parse(await response.json())
    .items[0];
  if (task === undefined) throw new Error('Approval missing');
  await page.goto(`/w/${workspaceId}/requests/${task.id}`);
  return task;
}

test('an unanswered approval continues on Timed out to a later step; one without the choice still fails', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  await mkdir(screenshots, { recursive: true });
  await registerEditorUser(page, request, mailOrigin, 'Timeout owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Timeout qualification',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // Choosing the Timed out path in the setup draws its port on the canvas.
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Order approval',
  );
  await saveDraft(page, workflowPath, approvalGraph());
  await page.reload();
  const timedOutPort = page.getByRole('img', {
    name: 'Manager approval: output Timed out',
    exact: true,
  });
  await expect(timedOutPort).toHaveCount(0);
  await page.getByTestId('rf__node-approval').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('then fails the step')).toBeVisible();
  await page.getByText('Continue on Timed out', { exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes.find(
          (item) => item.id === 'approval',
        )?.config.onExpiry,
    )
    .toBe('continue');
  await expect(timedOutPort).toBeVisible();
  await expect(page.getByText('then continues on Timed out')).toBeVisible();

  // Link Timed out to an escalation step, as a builder would.
  const chosen = (await readEditorDraft(page, workflowPath)).graph;
  await saveDraft(page, workflowPath, {
    ...chosen,
    nodes: [
      ...chosen.nodes,
      createWorkflowNodeFixture({
        id: 'escalate',
        label: 'Escalate',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 560, y: 480 },
      }),
    ],
    edges: [
      ...chosen.edges,
      {
        id: 'timed-out',
        source: { nodeId: 'approval', port: 'timed_out' },
        target: { nodeId: 'escalate', port: 'in' },
      },
    ],
  });
  await page.reload();
  await expect(
    page
      .getByRole('list', { name: 'Outputs' })
      .getByText('Timed out → Escalate', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${screenshots}/canvas-1440.png` });
  await publishSingleStep(page, workflowPath);

  const continued = await runUntilExpiry(page, { workspaceId, mailOrigin });
  const finished = await waitForRun(page, workspaceId, continued, 'succeeded');
  expect(
    finished.nodes.find((item) => item.nodeId === 'escalate')?.status,
  ).toBe('succeeded');
  expect(
    finished.nodes.find((item) => item.nodeId === 'approved')?.status,
  ).toBe('skipped');
  await page.goto(`/w/${workspaceId}/runs/${continued}`);
  await expect(page.getByText('Timed out after 7 days').first()).toBeVisible();
  await page.screenshot({
    path: `${screenshots}/run-1440.png`,
    fullPage: true,
  });
  const task = await openTask(page, workspaceId, continued);
  expect(task).toMatchObject({ status: 'expired', onExpiry: 'continue' });
  await expect(page.getByText('Timed out after 7 days')).toBeVisible();
  await expect(
    page.getByText(
      'Nobody responded in time, so the run continued on its Timed out path.',
    ),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${screenshots}/request-390.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  // An approval left on the default still fails its step on expiry.
  await page.setViewportSize({ width: 1440, height: 900 });
  const failingPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Order approval without timeout',
  );
  await saveDraft(page, failingPath, approvalGraph());
  await page.reload();
  await publishSingleStep(page, failingPath);
  const failed = await runUntilExpiry(page, { workspaceId, mailOrigin });
  const ended = await waitForRun(page, workspaceId, failed, 'failed');
  expect(
    ended.nodes.find((item) => item.nodeId === 'approval')?.safeErrorCode,
  ).toBe('pending_task.expired');
  await openTask(page, workspaceId, failed);
  await expect(
    page.getByText(
      'This request expired, so its step failed. A failure route takes over if the workflow has one.',
    ),
  ).toBeVisible();
});
