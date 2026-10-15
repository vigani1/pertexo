import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { approvalConfigSchema } from '@pertexo/workflow-model';
import {
  apiProblemSchema,
  pendingTaskListResponseSchema,
} from '@pertexo/contracts';
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
async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find(
    (value) => value.name === 'pertexo_csrf',
  );
  if (cookie === undefined) throw new Error('CSRF missing');
  return decodeURIComponent(cookie.value);
}
const node = (id: string, key: string, x: number) => ({
  id,
  definition: { key, version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x, y: 0 },
});
test('a starter cannot decide; a named viewer approves and rejects real runs through inbox and mobile decisions', async ({
  page,
  browser,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  const ownerEmail = await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Approval owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Approval qualification',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Review a request',
  );
  const workflowId = workflowPath.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow missing');
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    const decider = await context.newPage();
    const viewerEmail = await registerEditorUser(
      decider,
      request,
      mailOrigin,
      'Approval viewer',
    );
    const setup = await request.post(`${mailOrigin}/readonly-setup`, {
      data: { workspaceId, workflowId, ownerEmail, viewerEmail },
    });
    expect(setup.status()).toBe(200);
    const identity = (await setup.json()) as { viewerId: string };
    const draft = await page.request.get(`${workflowPath}/draft`);
    expect(draft.status()).toBe(200);
    const graph = {
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        node('manual', 'core.manual', 0),
        {
          ...node('approval', 'core.approval', 260),
          config: approvalConfigSchema.parse({
            title: 'Review the request',
            instructions: 'Confirm the request is ready.',
            audience: { roles: [], memberIds: [identity.viewerId] },
          }),
        },
        node('approved', 'core.terminate', 520),
        node('rejected', 'core.terminate', 520),
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
    const saved = await page.request.put(`${workflowPath}/draft`, {
      headers: {
        'If-Match': draft.headers().etag ?? '',
        'x-csrf-token': await csrf(page),
      },
      data: { graph },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    await page.reload();
    await page.getByTestId('rf__node-approval').focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('group', { name: 'Who can decide' }),
    ).toBeVisible();
    await expect(
      page.getByText('Approval viewer', { exact: true }).first(),
    ).toBeVisible();
    await page.getByLabel('Instructions', { exact: true }).fill('');
    await page.keyboard.press('Tab');
    await expect
      .poll(
        async () =>
          (await readEditorDraft(page, workflowPath)).graph.nodes.find(
            (item) => item.id === 'approval',
          )?.config.instructions,
      )
      .toBe('');
    await page
      .getByLabel('Instructions', { exact: true })
      .fill('Confirm the request is ready.');
    await page.getByLabel('Request title', { exact: true }).fill('');
    await page.keyboard.press('Tab');
    await expect(
      page.getByText('Enter a title up to 160 characters.', { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel('Request title', { exact: true })
      .fill('Review the request ');
    await page.keyboard.press('Tab');
    await expect
      .poll(
        async () =>
          (await readEditorDraft(page, workflowPath)).graph.nodes.find(
            (item) => item.id === 'approval',
          )?.config.title,
      )
      .toBe('Review the request');
    await publishSingleStep(page, workflowPath);
    await mkdir('/tmp/pertexo-approval-screenshots', { recursive: true });
    for (const [decision, width] of [
      ['approved', 1280],
      ['rejected', 375],
    ] as const) {
      await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
      const runId = await startSingleStep(page, {});
      await waitForRun(page, workspaceId, runId, 'waiting');
      await expect(
        page.getByText('execution budget paused', { exact: true }),
      ).toBeVisible();
      const response = await page.request.get(
        `/v1/workspaces/${workspaceId}/pending-tasks?view=all&status=pending&runId=${runId}`,
      );
      expect(response.status(), await response.text()).toBe(200);
      const task = pendingTaskListResponseSchema.parse(await response.json())
        .items[0];
      if (task === undefined) throw new Error('Approval missing');
      const refused = await page.request.post(
        `/v1/workspaces/${workspaceId}/pending-tasks/${task.id}/decide`,
        {
          headers: {
            'x-csrf-token': await csrf(page),
            'Idempotency-Key': randomUUID(),
          },
          data: { decision },
        },
      );
      expect(refused.status()).toBe(403);
      expect(apiProblemSchema.parse(await refused.json()).code).toBe(
        'pending_task.self_decision',
      );
      await decider.setViewportSize({ width, height: 768 });
      await decider.emulateMedia({ reducedMotion: 'reduce' });
      await decider.goto(`/w/${workspaceId}/inbox`);
      const notices = decider.getByRole('list', {
        name: 'Notices',
        exact: true,
      });
      await expect(
        notices.getByText('Approval waiting', { exact: true }),
      ).toBeVisible();
      await expect(
        notices.getByRole('link', { name: 'Review approval', exact: true }),
      ).toHaveCount(1);
      await notices
        .getByRole('link', { name: 'Review approval', exact: true })
        .click();
      await expect(
        decider.getByRole('heading', {
          name: 'Review the request',
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await decider.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await decider.screenshot({
        path: `/tmp/pertexo-approval-screenshots/${decision}-${String(width)}-before.png`,
        fullPage: true,
      });
      await decider
        .getByLabel('Comment (optional)', { exact: true })
        .fill('Reviewed in the browser');
      const button = decider.getByRole('button', {
        name: decision === 'approved' ? 'Approve' : 'Reject',
        exact: true,
      });
      await button.focus();
      await decider.keyboard.press('Enter');
      await expect(
        decider.getByRole('heading', {
          name: new RegExp(`Approval viewer ${decision} this request`, 'u'),
        }),
      ).toBeVisible();
      await waitForRun(decider, workspaceId, runId, 'succeeded');
      await decider.screenshot({
        path: `/tmp/pertexo-approval-screenshots/${decision}-${String(width)}-after.png`,
        fullPage: true,
      });
    }
  } finally {
    await context.close();
  }
});
