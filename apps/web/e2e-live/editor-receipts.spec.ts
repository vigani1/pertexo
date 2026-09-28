import { expect } from '@playwright/test';
import {
  workflowPublishResponseSchema,
  workflowVersionsResponseSchema,
} from '@pertexo/contracts/schemas/workflow-authoring';
import {
  workflowRunStartRequestSchema,
  workflowRunStartResponseSchema,
  workflowNodeRunOutputResponseSchema,
} from '@pertexo/contracts/schemas/workflow-runs';
import { test } from './support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from './support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
  waitForRun,
} from './support/single-step-authoring';

test('committed publish and run responses recover their exact original commands', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mailOrigin, 'Receipt recovery owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Exact receipt recovery',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Original receipt intent',
  );
  const workflowId = workflowPath.split('/')[5];
  if (workflowId === undefined) throw new Error('Workflow identifier missing');
  const nodeId = await addSingleStep(
    page,
    workflowPath,
    /Set fields/u,
    'Receipt source',
  );
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill('proof');
  await row.getByRole('button', { name: 'Run input', exact: true }).click();
  await row.getByLabel('Run input path', { exact: true }).fill('$.proof');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]
          ?.inputMappings,
    )
    .toEqual({ proof: { kind: 'run_input', path: '$.proof' } });
  const originalDraft = await readEditorDraft(page, workflowPath);
  const publishes: { key: string; etag: string; body: string | null }[] = [];
  let acceptedVersionId: string | undefined;
  await page.route(`**${workflowPath}/publish`, async (route) => {
    const headers = route.request().headers();
    const command = {
      key: headers['idempotency-key'] ?? '',
      etag: headers['if-match'] ?? '',
      body: route.request().postData(),
    };
    expect(command.key).not.toBe('');
    expect(command.etag).not.toBe('');
    publishes.push(command);
    const response = await route.fetch(); // The real server commits before the browser loses its response.
    expect(response.status()).toBe(200);
    const result = workflowPublishResponseSchema.parse(await response.json());
    if (publishes.length === 1) {
      acceptedVersionId = result.version.id;
      expect(result.reused).toBe(false);
      await route.abort('failed');
    } else {
      expect(command).toEqual(publishes[0]);
      expect(result.version.id).toBe(acceptedVersionId);
      await route.fulfill({ response });
    }
  });
  await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
  const lens = page.getByRole('dialog', { name: 'Publish v1', exact: true });
  await lens.getByRole('button', { name: 'Publish v1', exact: true }).click();
  await expect(
    lens.getByRole('button', { name: 'Retry original publish', exact: true }),
  ).toBeVisible();
  expect(publishes).toHaveLength(1);
  await lens.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page
    .getByLabel('Label', { exact: true })
    .fill('Newer unpublished name');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]?.label,
    )
    .toBe('Newer unpublished name');
  // The view may now know v1 exists. Recovery must remain the original attempt,
  // not whichever version number a refreshed preview suggests publishing next.
  await page.getByRole('button', { name: /^Publish v[12]$/u }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Retry original publish', exact: true })
    .click();
  await expect(page.getByText('v1 is live', { exact: true })).toBeVisible();
  expect(publishes).toHaveLength(2);
  const versionsResponse = await page.request.get(`${workflowPath}/versions`);
  expect(versionsResponse.status()).toBe(200);
  const versions = workflowVersionsResponseSchema.parse(
    await versionsResponse.json(),
  );
  expect(versions.items).toHaveLength(1);
  expect(versions.items[0]?.graph).toEqual(originalDraft.graph);
  const runs: { key: string; body: string | null }[] = [];
  let acceptedRunId: string | undefined;
  let originalDeadline: string | undefined;
  await page.route(`**${workflowPath}/runs`, async (route) => {
    const command = {
      key: route.request().headers()['idempotency-key'] ?? '',
      body: route.request().postData(),
    };
    expect(command.key).not.toBe('');
    runs.push(command);
    const body = workflowRunStartRequestSchema.parse(
      route.request().postDataJSON(),
    );
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    const result = workflowRunStartResponseSchema.parse(await response.json());
    if (runs.length === 1) {
      acceptedRunId = result.run.id;
      originalDeadline = body.deadlineAt;
      expect(body.input).toEqual({ proof: 'original-run-input' });
      expect(originalDeadline).toBeDefined();
      expect(result.replayed).toBe(false);
      await route.abort('failed');
    } else {
      expect(command).toEqual(runs[0]);
      expect(body.input).toEqual({ proof: 'original-run-input' });
      expect(body.deadlineAt).toBe(originalDeadline);
      expect(result.run.id).toBe(acceptedRunId);
      expect(result.replayed).toBe(true);
      await route.fulfill({ response });
    }
  });
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Run with input…', exact: true })
    .click();
  const runLens = page.getByRole('dialog', {
    name: 'Run with input',
    exact: true,
  });
  await runLens
    .getByLabel('Run input (JSON)', { exact: true })
    .fill('{"proof":"original-run-input"}');
  await runLens.getByRole('button', { name: 'In 1 hour', exact: true }).click();
  await runLens
    .getByRole('button', { name: 'Start published version', exact: true })
    .click();
  await expect(
    runLens.getByRole('button', { name: 'Retry same run', exact: true }),
  ).toBeVisible();
  expect(runs).toHaveLength(1);
  await runLens
    .getByLabel('Run input (JSON)', { exact: true })
    .fill('{"proof":"different-scratch"}');
  await runLens.getByRole('button', { name: 'None', exact: true }).click();
  await runLens
    .getByRole('button', { name: 'Retry same run', exact: true })
    .click();
  await expect(page).toHaveURL(
    `/w/${workspaceId}/runs/${acceptedRunId ?? 'missing'}`,
  );
  expect(runs).toHaveLength(2);
  if (
    acceptedRunId === undefined ||
    acceptedVersionId === undefined ||
    originalDeadline === undefined
  )
    throw new Error('Committed receipt IDs missing');
  const accepted = await waitForRun(
    page,
    workspaceId,
    acceptedRunId,
    'succeeded',
  );
  expect(accepted.run.workflowVersionId).toBe(acceptedVersionId);
  expect(accepted.run.deadlineAt).toBe(originalDeadline);
  expect(accepted.nodes).toHaveLength(1);
  const node = accepted.nodes[0];
  if (node === undefined) throw new Error('Accepted run step missing');
  const output = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${acceptedRunId}/node-runs/${node.id}/output`,
  );
  expect(output.status()).toBe(200);
  expect(
    workflowNodeRunOutputResponseSchema.parse(await output.json()).output,
  ).toEqual({ kind: 'inline', value: { proof: 'original-run-input' } });
  const evidence = await request.post(`${mailOrigin}/evidence/receipts`, {
    data: {
      workspaceId,
      workflowId,
      nodeId,
      workflowVersionId: acceptedVersionId,
      runId: acceptedRunId,
      publishKey: publishes[0]?.key,
      runKey: runs[0]?.key,
      deadlineAt: originalDeadline,
    },
  });
  expect(evidence.status()).toBe(204);
});
