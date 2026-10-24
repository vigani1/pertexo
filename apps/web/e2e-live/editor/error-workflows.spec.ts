import { createWorkflowNodeFixture } from '../../test/support/fixtures/graph';
import { mkdir } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { workflowNodeRunOutputResponseSchema } from '@pertexo/contracts';
import { workflowErrorInputSchema, isRecord } from '@pertexo/workflow-model';
import { test } from '../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  addSingleStep,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../support/authoring/single-step';

async function saveGraph(
  page: Page,
  path: string,
  graph: WorkflowGraphContract,
) {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'pertexo_csrf',
  );
  if (csrf === undefined) throw new Error('CSRF missing');
  const draft = await page.request.get(`${path}/draft`);
  expect(draft.status()).toBe(200);
  const saved = await page.request.put(`${path}/draft`, {
    headers: {
      'x-csrf-token': decodeURIComponent(csrf.value),
      'If-Match': draft.headers().etag ?? '',
    },
    data: { graph },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.reload();
}

test('selects a published error workflow, starts it with safe data, and follows the error run on desktop and phone', async ({
  page,
  request,
}) => {
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (origin === undefined) throw new Error('Owned mail listener missing');
  await registerEditorUser(page, request, origin, 'Error workflow owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Error workflow qualification',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const targetPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Handle a workflow failure',
  );
  await addSingleStep(
    page,
    targetPath,
    /When a workflow fails/u,
    'Safe failure entry',
  );
  await saveGraph(page, targetPath, {
    settings: {},
    nodes: [
      createWorkflowNodeFixture({
        id: 'error',
        definition: { key: 'core.workflow_error', version: 1 },
        position: { x: 0, y: 0 },
      }),
      {
        ...createWorkflowNodeFixture({
          id: 'summary',
          definition: { key: 'core.set', version: 1 },
          position: { x: 250, y: 0 },
        }),
        inputMappings: {
          failure: { kind: 'node_output', nodeId: 'error', path: '$' },
        },
      },
      createWorkflowNodeFixture({
        id: 'stop',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 500, y: 0 },
      }),
    ],
    edges: [
      {
        id: 'error-summary',
        source: { nodeId: 'error', port: 'out' },
        target: { nodeId: 'summary', port: 'in' },
      },
      {
        id: 'summary-stop',
        source: { nodeId: 'summary', port: 'out' },
        target: { nodeId: 'stop', port: 'in' },
      },
    ],
  });
  await publishSingleStep(page, targetPath);
  const sourcePath = await createEditorWorkflow(
    page,
    workspaceId,
    'Error workflow source',
  );
  await saveGraph(page, sourcePath, {
    settings: {},
    nodes: [
      createWorkflowNodeFixture({
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
      }),
      {
        ...createWorkflowNodeFixture({
          id: 'summarize',
          definition: { key: 'core.summarize', version: 1 },
          position: { x: 250, y: 0 },
        }),
        config: { valuePath: '$.amount', missing: 'error' },
        inputMappings: {
          items: { kind: 'literal', value: [{ amount: 'not-a-number' }] },
        },
      },
      createWorkflowNodeFixture({
        id: 'stop',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 500, y: 0 },
      }),
    ],
    edges: [
      {
        id: 'manual-summarize',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'summarize', port: 'in' },
      },
      {
        id: 'summarize-stop',
        source: { nodeId: 'summarize', port: 'out' },
        target: { nodeId: 'stop', port: 'in' },
      },
    ],
  });
  await publishSingleStep(page, sourcePath);
  const workflowId = sourcePath.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Source ID missing');
  const editor = `/w/${workspaceId}/workflows/${workflowId}`;
  await page.goto(`${editor}/settings`);
  const section = page.getByRole('region', {
    name: 'Error workflow',
    exact: true,
  });
  await section.getByRole('button', { name: 'Change' }).click();
  const picker = section.getByRole('combobox', {
    name: 'When this workflow fails, run …',
  });
  await picker.click();
  await page
    .getByRole('option', { name: 'Handle a workflow failure', exact: true })
    .click();
  await section
    .getByRole('button', { name: 'Save error workflow', exact: true })
    .click();
  await expect(
    page.getByText('Error workflow saved', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    section.getByText(
      'When this workflow fails, Pertexo runs Handle a workflow failure.',
    ),
  ).toBeVisible();
  await section.getByRole('button', { name: 'Change' }).click();
  await expect(picker).toContainText('Handle a workflow failure');
  await mkdir('/tmp/pertexo-error-workflow-screenshots', { recursive: true });
  await section.screenshot({
    path: '/tmp/pertexo-error-workflow-screenshots/settings-desktop.png',
  });
  await page.setViewportSize({ width: 375, height: 768 });
  await picker.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await section.screenshot({
    path: '/tmp/pertexo-error-workflow-screenshots/settings-phone.png',
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(editor);
  const runId = await startSingleStep(page, { password: 'sensitive-password' });
  await waitForRun(page, workspaceId, runId, 'failed');
  await expect(
    page.getByText('Error workflow started', { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  const notice = page
    .locator('[data-slot="notice"]')
    .filter({ hasText: 'Error workflow started' });
  await notice.screenshot({
    path: '/tmp/pertexo-error-workflow-screenshots/source-desktop.png',
  });
  await page.setViewportSize({ width: 375, height: 768 });
  await notice.screenshot({
    path: '/tmp/pertexo-error-workflow-screenshots/source-phone.png',
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('link', { name: 'Open error run', exact: true }).click();
  const errorRunId = new URL(page.url()).pathname.split('/').at(-1);
  if (errorRunId === undefined) throw new Error('Error run ID missing');
  const run = await waitForRun(page, workspaceId, errorRunId, 'succeeded');
  expect(run.run.triggerType).toBe('workflow_error');
  const summary = run.nodes.find((step) => step.nodeId === 'summary');
  if (summary === undefined) throw new Error('Summary step missing');
  const output = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${errorRunId}/node-runs/${summary.id}/output`,
  );
  expect(output.status()).toBe(200);
  const stored = workflowNodeRunOutputResponseSchema.parse(
    await output.json(),
  ).output;
  if (stored.kind !== 'inline') throw new Error('Expected inline summary');
  if (!isRecord(stored.value))
    throw new Error('Summary output must be an object');
  const value = workflowErrorInputSchema.parse(stored.value.failure);
  expect(value.run.id).toBe(runId);
  expect(JSON.stringify(value)).not.toMatch(/sensitive-password|not-a-number/u);
  await page.screenshot({
    path: '/tmp/pertexo-error-workflow-screenshots/run-desktop.png',
  });
  await page.setViewportSize({ width: 375, height: 768 });
  await expect(
    page.getByText('workflow failure', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/pertexo-error-workflow-screenshots/run-phone.png',
  });
});
