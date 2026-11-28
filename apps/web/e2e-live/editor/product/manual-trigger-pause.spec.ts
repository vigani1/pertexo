import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  scheduleOccurrenceListResponseSchema,
  scheduleTriggerListResponseSchema,
  webhookTriggerListResponseSchema,
  workflowTestAcceptedSchema,
  workflowTestDetailSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import { createWorkflowNodeFixture } from '../../../test/support/fixtures/graph';
import {
  createEditorWorkflow,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import { saveGraph } from '../callable/fixture';
import { test } from './account';
import { sendSigned } from './steps';

test('pausing and resuming from Settings gates live webhooks, forms and schedules', async ({
  page,
}) => {
  const origin = process.env.PERTEXO_API_PROXY_TARGET;
  if (origin === undefined) throw new Error('Use the owned API fixture');
  const workspaceId = await openNewEditorWorkspace(
    page,
    'Manual trigger pause',
  );
  const formWorkflow = await publish(
    page,
    workspaceId,
    'Request form',
    'core.form',
    {
      title: 'Send a request',
      fields: [
        { id: 'message', name: 'message', label: 'Message', type: 'text' },
      ],
    },
  );
  const webhookWorkflow = await publish(
    page,
    workspaceId,
    'Webhook intake',
    'core.webhook',
  );
  const manualWorkflow = await publish(
    page,
    workspaceId,
    'Manual intake',
    'core.manual',
  );
  const scheduleWorkflow = await publish(
    page,
    workspaceId,
    'Scheduled intake',
    'core.schedule',
    {
      kind: 'interval',
      intervalMinutes: 1,
      misfirePolicy: 'catch_up_once',
    },
  );
  const csrf = await readCsrfToken(page);

  async function readSchedules() {
    const response = await page.request.get(
      `${scheduleWorkflow.workflowPath}/triggers/schedules`,
    );
    expect(response.status()).toBe(200);
    return scheduleTriggerListResponseSchema.parse(await response.json()).items;
  }

  await page.goto(`${webhookWorkflow.buildPath}/triggers`);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `${webhookWorkflow.workflowPath}/triggers`,
      );
      expect(response.status()).toBe(200);
      return webhookTriggerListResponseSchema.parse(await response.json())
        .items[0]?.status;
    })
    .toBe('configuration_required');
  const hook = page.getByRole('article', { name: /^Webhook:/u });
  await hook
    .locator('summary')
    .filter({ hasText: /^Manage$/u })
    .click();
  await hook
    .getByRole('button', { name: 'Create endpoint', exact: true })
    .click();
  const reveal = page.getByRole('dialog', {
    name: 'Store these now',
    exact: true,
  });
  await expect(reveal).toBeVisible();
  const [endpoint, secret] = (
    await reveal.locator('code').allTextContents()
  ).filter((code) => /^[\w-]{43}$/u.test(code));
  if (endpoint === undefined || secret === undefined)
    throw new Error('Transient webhook credentials missing');
  const hookUrl = new URL(`/hooks/${endpoint}`, origin).toString();
  await reveal
    .getByRole('checkbox', { name: 'I’ve stored these', exact: true })
    .check();
  await reveal.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(reveal).toBeHidden();
  await expect
    .poll(async () => (await readSchedules())[0]?.status)
    .toBe('active');
  const schedule = (await readSchedules())[0];
  if (schedule === undefined) throw new Error('Published schedule missing');
  const triggerId = schedule.id;

  await changePause(page, scheduleWorkflow.buildPath, 'Pause triggers');
  await changePause(page, webhookWorkflow.buildPath, 'Pause triggers');
  await expect(page.getByText(/Paused by Product owner · /u)).toBeVisible();
  const refusedWebhook = await sendSigned(hookUrl, secret);
  expect(refusedWebhook.status).toBe(423);
  expect(await refusedWebhook.json()).toMatchObject({
    code: 'webhook.workflow_paused',
  });

  await page.goto(`/w/${workspaceId}/workflows`);
  await expect(page.getByText('Paused', { exact: true })).toHaveCount(2);
  await changePause(page, manualWorkflow.buildPath, 'Pause triggers');
  await page.goto(manualWorkflow.buildPath);
  const manual = await startSingleStep(page, {});
  await waitForRun(page, workspaceId, manual, 'succeeded');
  await page.goto(manualWorkflow.buildPath);
  await testDraft(page, manualWorkflow.workflowPath);

  const form = () =>
    page.request.post(`${formWorkflow.workflowPath}/form/submit`, {
      headers: { 'x-csrf-token': csrf, 'Idempotency-Key': randomUUID() },
      data: {
        versionId: formWorkflow.version.id,
        values: { message: 'A real submission' },
      },
    });
  await changePause(page, formWorkflow.buildPath, 'Pause triggers');
  const refusedForm = await form();
  expect(refusedForm.status()).toBe(404);
  expect(await refusedForm.json()).toMatchObject({ code: 'form.unavailable' });

  async function occurrences() {
    const response = await page.request.get(
      `${scheduleWorkflow.workflowPath}/triggers/${triggerId}/schedule/occurrences?limit=10`,
    );
    expect(response.status()).toBe(200);
    return scheduleOccurrenceListResponseSchema.parse(await response.json())
      .items;
  }
  await expect
    .poll(
      async () =>
        (await occurrences()).find(({ outcome }) => outcome === 'paused'),
      {
        timeout: 75_000,
        intervals: [1_000],
      },
    )
    .toMatchObject({ outcome: 'paused', runId: null });

  await changePause(page, formWorkflow.buildPath, 'Resume triggers');
  const acceptedForm = await form();
  expect(acceptedForm.status(), await acceptedForm.text()).toBe(200);
  await changePause(page, webhookWorkflow.buildPath, 'Resume triggers');
  await changePause(page, manualWorkflow.buildPath, 'Resume triggers');
  await changePause(page, scheduleWorkflow.buildPath, 'Resume triggers');
  const acceptedWebhook = await sendSigned(hookUrl, secret);
  expect(acceptedWebhook.status).toBe(202);
  await expect
    .poll(async () => (await occurrences())[0]?.outcome, {
      timeout: 75_000,
      intervals: [1_000],
    })
    .toBe('accepted');
  const accepted = (await occurrences())[0];
  if (accepted?.runId == null) throw new Error('Resumed schedule run missing');
  await waitForRun(page, workspaceId, accepted.runId, 'succeeded');
});

async function changePause(
  page: Page,
  buildPath: string,
  action: 'Pause triggers' | 'Resume triggers',
) {
  await page.goto(`${buildPath}/settings`);
  const state = page.getByRole('region', {
    name: 'Workflow state',
    exact: true,
  });
  await state.getByRole('button', { name: action, exact: true }).click();
  await expect(
    state.getByRole('button', {
      name: action === 'Pause triggers' ? 'Resume triggers' : 'Pause triggers',
      exact: true,
    }),
  ).toBeEnabled();
}

async function publish(
  page: Page,
  workspaceId: string,
  name: string,
  key: string,
  config: WorkflowGraphContract['nodes'][number]['config'] = {},
) {
  const workflowPath = await createEditorWorkflow(page, workspaceId, name);
  const buildPath = new URL(page.url()).pathname.replace(/\/$/u, '');
  await saveGraph(page, workflowPath, {
    nodes: [
      createWorkflowNodeFixture({
        id: 'start',
        definition: { key, version: 1 },
        config,
      }),
    ],
    edges: [],
    settings: {},
  });
  await page.reload();
  const version = await publishSingleStep(page, workflowPath);
  return { workflowPath, buildPath, version };
}

async function testDraft(page: Page, workflowPath: string) {
  await page
    .getByRole('button', { name: 'Test and run actions', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'Test workflow', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Test workflow',
    exact: true,
  });
  await dialog.getByLabel('Test input (JSON)', { exact: true }).fill('{}');
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`${workflowPath}/draft/tests`),
  );
  await dialog.getByRole('button', { name: 'Start test', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const { runId } = workflowTestAcceptedSchema.parse(await response.json());
  await expect
    .poll(
      async () => {
        const detail = await page.request.get(
          `${workflowPath}/draft/tests/${runId}`,
        );
        expect(detail.status()).toBe(200);
        return workflowTestDetailSchema.parse(await detail.json()).status;
      },
      { timeout: 15_000 },
    )
    .toBe('succeeded');
}
