import { createWorkflowNodeFixture } from '../../test/support/fixtures/graph';
import { readCsrfToken } from '../../test/support/browser/csrf';
import './callbacks/journey.case';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { approvalConfigSchema } from '@pertexo/workflow-model';
import {
  apiProblemSchema,
  pendingTaskListResponseSchema,
  pendingTaskDecisionResponseSchema,
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
        createWorkflowNodeFixture({
          id: 'manual',
          definition: { key: 'core.manual', version: 1 },
          position: { x: 0, y: 0 },
        }),
        {
          ...createWorkflowNodeFixture({
            id: 'approval',
            definition: { key: 'core.approval', version: 1 },
            position: { x: 260, y: 0 },
          }),
          config: approvalConfigSchema.parse({
            title: 'Review the request',
            instructions: 'Confirm the request is ready.',
            audience: { roles: [], memberIds: [identity.viewerId] },
          }),
          inputMappings: {
            details: {
              kind: 'node_output',
              nodeId: 'manual',
              path: '$.review',
            },
          },
        },
        createWorkflowNodeFixture({
          id: 'approved',
          definition: { key: 'core.terminate', version: 1 },
          position: { x: 520, y: 0 },
        }),
        createWorkflowNodeFixture({
          id: 'rejected',
          definition: { key: 'core.terminate', version: 1 },
          position: { x: 520, y: 0 },
        }),
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
        'x-csrf-token': await readCsrfToken(page),
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
      const runId = await startSingleStep(page, {
        review: { Amount: 120, Customer: 'Captured customer', Ready: false },
      });
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
      expect(task.details).toEqual({
        Amount: 120,
        Customer: 'Captured customer',
        Ready: false,
      });
      const refused = await page.request.post(
        `/v1/workspaces/${workspaceId}/pending-tasks/${task.id}/decide`,
        {
          headers: {
            'x-csrf-token': await readCsrfToken(page),
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
        notices.getByText('Captured customer', { exact: true }),
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
      await expect(
        decider.getByText('Captured customer', { exact: true }),
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
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
    await page.getByTestId('rf__node-approval').focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('group', { name: 'Who can decide' })
      .getByRole('checkbox', { name: 'owner', exact: true })
      .check();
    await page
      .getByRole('button', {
        name: 'Remove Approval viewer from audience',
        exact: true,
      })
      .click();
    const hint =
      'If you start this run, nobody else in this audience can decide. Allow the starter or choose another member.';
    await expect(page.getByText(hint, { exact: true })).toBeVisible();
    await page.screenshot({
      path: '/tmp/pertexo-approval-screenshots/starter-settings-1280.png',
      fullPage: true,
    });
    const starter = page.getByRole('checkbox', {
      name: 'Allow the person who started the run to decide',
      exact: true,
    });
    await starter.focus();
    await page.keyboard.press('Space');
    await expect(starter).toBeChecked();
    await expect(page.getByText(hint, { exact: true })).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await readEditorDraft(page, workflowPath)).graph.nodes.find(
            (item) => item.id === 'approval',
          )?.config.allowStarterToDecide,
      )
      .toBe(true);
    await page.setViewportSize({ width: 375, height: 768 });
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
    await starter.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: '/tmp/pertexo-approval-screenshots/starter-settings-375.png',
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Publish v2', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Publish v2', exact: true })
      .getByRole('button', { name: 'Publish v2', exact: true })
      .click();
    await expect(page.getByText('v2 is live', { exact: true })).toBeVisible();
    const runId = await startSingleStep(page, {
      review: { Amount: 120, Customer: 'Captured customer', Ready: false },
    });
    await waitForRun(page, workspaceId, runId, 'waiting');
    await page.goto(`/w/${workspaceId}/inbox`);
    await page
      .getByRole('list', { name: 'Notices', exact: true })
      .getByRole('link', { name: 'Review approval', exact: true })
      .click();
    await page
      .getByLabel('Comment (optional)', { exact: true })
      .fill('Self-approved by configured starter');
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith('/decide') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(
      pendingTaskDecisionResponseSchema.parse(await response.json()).task
        .output,
    ).toMatchObject({ decidedByName: 'Approval owner' });
    await expect(
      page.getByRole('heading', {
        name: /Approval owner approved this request/u,
      }),
    ).toBeVisible();
    await waitForRun(page, workspaceId, runId, 'succeeded');
  } finally {
    await context.close();
  }
});
