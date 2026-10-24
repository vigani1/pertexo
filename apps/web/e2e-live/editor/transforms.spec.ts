import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import {
  workflowNodeRunOutputResponseSchema,
  nodeTestRequestSchema,
  nodeTestExecuteAcceptedResponseSchema,
  previewRunResponseSchema,
} from '@pertexo/contracts';
import {
  parsePortableJson,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model';
import { test } from '../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  readEditorDraft,
  addSingleStep,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../support/authoring/single-step';
import {
  authorCollectionGraph,
  invoiceInput,
  invoiceGroups,
} from '../support/authoring/transforms';
import { openWorkflowAction } from '../support/authoring/workflow-actions';

async function readOutput(
  page: Page,
  workspaceId: string,
  runId: string,
  nodeRunId: string,
) {
  const response = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${nodeRunId}/output`,
  );
  expect(response.ok()).toBe(true);
  return workflowNodeRunOutputResponseSchema.parse(await response.json())
    .output;
}

async function testStep({
  page,
  workspaceId,
  workflowPath,
  nodeId,
  input,
}: Readonly<{
  page: Page;
  workspaceId: string;
  workflowPath: string;
  nodeId: string;
  input: unknown;
}>) {
  await page.getByTestId(`rf__node-${nodeId}`).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page
    .getByLabel('Sample input (JSON)', { exact: true })
    .fill(JSON.stringify(input));
  await page.getByRole('button', { name: 'Check setup', exact: true }).click();
  await expect(
    page.getByText('Setup looks right', { exact: true }),
  ).toBeVisible();
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `${workflowPath}/draft/nodes/${nodeId}/test` &&
      nodeTestRequestSchema.safeParse(response.request().postDataJSON()).data
        ?.mode === 'test_execute',
  );
  await page.getByRole('button', { name: /^Run (?:another )?test$/u }).click();
  const accepted = nodeTestExecuteAcceptedResponseSchema.parse(
    await (await pending).json(),
  );
  const path = `/v1/workspaces/${workspaceId}/previews/${accepted.preview.id}`;
  async function read() {
    const response = await page.request.get(path);
    expect(response.ok()).toBe(true);
    return previewRunResponseSchema.parse(await response.json()).preview;
  }
  await expect.poll(async () => (await read()).status).toBe('succeeded');
  await expect(page.getByRole('region', { name: 'Test result' })).toContainText(
    'Test passed',
  );
  return read();
}

async function session(
  page: Page,
  request: Parameters<typeof registerEditorUser>[1],
  name: string,
) {
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (origin === undefined) throw new Error('Use the owned API editor fixture');
  await registerEditorUser(page, request, origin, name);
  return { origin, workspaceId: await createEditorWorkspace(page, name) };
}

test('authors, previews, publishes and runs the collection chain and its portable copy', async ({
  page,
  request,
}) => {
  const { origin, workspaceId } = await session(
    page,
    request,
    'Transform owner',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Prepare paid invoices',
  );
  const workflowId = workflowPath.split('/').at(-1);
  if (workflowId === undefined)
    throw new Error('Transform workflow ID missing');
  const authored = await authorCollectionGraph(page, workflowPath);
  const saved = (await readEditorDraft(page, workflowPath)).graph;
  await page.reload();
  expect((await readEditorDraft(page, workflowPath)).graph).toEqual(saved);
  const preview = await testStep({
    page,
    workspaceId,
    workflowPath,
    nodeId: authored.filterId,
    input: invoiceInput,
  });
  expect(preview.output).toMatchObject({
    kind: 'inline',
    value: { inputCount: 5, removedCount: 1 },
  });
  const version = await publishSingleStep(page, workflowPath);
  const runId = await startSingleStep(page, invoiceInput);
  const sourceRun = await waitForRun(page, workspaceId, runId, 'succeeded');
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  await openWorkflowAction(page, 'Export…');
  const exportDialog = page.getByRole('dialog', {
    name: 'Export workflow',
    exact: true,
  });
  await exportDialog.getByRole('checkbox').check();
  const downloadPending = page.waitForEvent('download');
  await exportDialog
    .getByRole('button', { name: 'Download workflow JSON', exact: true })
    .click();
  const download = await downloadPending;
  const path = await download.path();
  const buffer = await readFile(path);
  const manifest = workflowPortableManifestSchema.parse(
    parsePortableJson(buffer.toString('utf8')),
  );
  expect(manifest.graph).toEqual(saved);
  await page.goto(`/w/${workspaceId}/workflows`);
  await page
    .getByRole('button', { name: 'Import workflow…', exact: true })
    .click();
  const importDialog = page.getByRole('dialog', {
    name: 'Import workflow',
    exact: true,
  });
  await importDialog
    .getByLabel('Workflow JSON file', { exact: true })
    .setInputFiles({
      name: 'invoices.json',
      mimeType: 'application/json',
      buffer,
    });
  await importDialog
    .getByLabel('New workflow name', { exact: true })
    .fill('Portable invoice preparation');
  await importDialog
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await expect(
    importDialog.getByText(/Compatible with this workspace/u),
  ).toBeVisible();
  await importDialog
    .getByRole('button', { name: 'Import unpublished draft', exact: true })
    .click();
  await importDialog
    .getByRole('button', { name: 'Open imported workflow', exact: true })
    .click();
  await expect(page).toHaveURL(/\/workflows\/[^/]+$/u);
  const importedWorkflowId = new URL(page.url()).pathname.split('/')[4];
  if (importedWorkflowId === undefined)
    throw new Error('Imported transform workflow ID missing');
  const importedPath = `/v1/workspaces/${workspaceId}/workflows/${importedWorkflowId}`;
  expect((await readEditorDraft(page, importedPath)).graph).toEqual(saved);
  const importedVersion = await publishSingleStep(page, importedPath);
  const importedRunId = await startSingleStep(page, invoiceInput);
  const importedRun = await waitForRun(
    page,
    workspaceId,
    importedRunId,
    'succeeded',
  );
  const filterRun = sourceRun.nodes.find(
    (node) => node.nodeId === authored.filterId,
  );
  const stopRun = importedRun.nodes.find(
    (node) => node.nodeId === authored.stopId,
  );
  if (filterRun === undefined || stopRun === undefined)
    throw new Error('Transform run steps missing');
  expect(await readOutput(page, workspaceId, runId, filterRun.id)).toEqual(
    preview.output,
  );
  expect(
    await readOutput(page, workspaceId, importedRunId, stopRun.id),
  ).toEqual({ kind: 'inline', value: { result: invoiceGroups } });
  const proof = await request.post(`${origin}/evidence/transforms`, {
    data: {
      workspaceId,
      workflowId,
      workflowVersionId: version.id,
      runId,
      importedWorkflowId,
      importedVersionId: importedVersion.id,
      importedRunId,
      filterId: authored.filterId,
      previewId: preview.id,
    },
  });
  expect(proof.status()).toBe(204);
});

test('authors a date conversion using an editable number example and verifies preview/run parity', async ({
  page,
  request,
}) => {
  const { origin, workspaceId } = await session(
    page,
    request,
    'Date transform owner',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Normalize timestamp',
  );
  const workflowId = workflowPath.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Date workflow ID missing');
  const dateId = await addSingleStep(
    page,
    workflowPath,
    /^Convert date\b/u,
    'UTC timestamp',
  );
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill('value');
  await row.getByRole('button', { name: 'Expression', exact: true }).click();
  await row.getByText('Expression examples', { exact: true }).click();
  await row
    .getByRole('button', { name: 'Use convert text to a number', exact: true })
    .click();
  await expect(
    row.getByRole('textbox', { name: 'Expression', exact: true }),
  ).toHaveValue('$number(runInput.text)');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]
          ?.inputMappings.value,
    )
    .toEqual({
      kind: 'expression',
      language: 'jsonata',
      expression: '$number(runInput.text)',
    });
  const input = { text: '1767225600000' };
  const initialPreview = await testStep({
    page,
    workspaceId,
    workflowPath,
    nodeId: dateId,
    input,
  });
  expect(initialPreview.output).toEqual({
    kind: 'inline',
    value: { value: '2026-01-01T00:00:00.000Z' },
  });
  async function operation(label: string) {
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.getByLabel('Date operation', { exact: true }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
  }
  await operation('Format timestamp');
  await page.getByLabel('Time zone', { exact: true }).fill('Europe/Paris');
  await page.keyboard.press('Tab');
  const formatPreview = await testStep({
    page,
    workspaceId,
    workflowPath,
    nodeId: dateId,
    input,
  });
  expect(formatPreview.output).toEqual({
    kind: 'inline',
    value: { value: '2026-01-01' },
  });
  await operation('Add or subtract duration');
  await page.getByLabel('Duration unit', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Calendar months (UTC)', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const amountRow = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await amountRow.getByLabel('Field', { exact: true }).fill('amount');
  await amountRow
    .getByRole('button', { name: 'Run input', exact: true })
    .click();
  await amountRow
    .getByLabel('Run input path', { exact: true })
    .fill('$.amount');
  await page.keyboard.press('Tab');
  const durationInput = { ...input, amount: 1 };
  const durationPreview = await testStep({
    page,
    workspaceId,
    workflowPath,
    nodeId: dateId,
    input: durationInput,
  });
  expect(durationPreview.output).toEqual({
    kind: 'inline',
    value: { value: '2026-02-01T00:00:00.000Z' },
  });
  await operation('Convert time zone');
  await page.getByLabel('Time zone', { exact: true }).fill('Europe/Paris');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]?.config,
    )
    .toEqual({ operation: 'convert_timezone', timeZone: 'Europe/Paris' });
  const saved = (await readEditorDraft(page, workflowPath)).graph;
  await page.reload();
  expect((await readEditorDraft(page, workflowPath)).graph).toEqual(saved);
  const preview = await testStep({
    page,
    workspaceId,
    workflowPath,
    nodeId: dateId,
    input: durationInput,
  });
  expect(preview.output).toEqual({
    kind: 'inline',
    value: { value: '2026-01-01T01:00:00.000+01:00' },
  });
  const version = await publishSingleStep(page, workflowPath);
  const runId = await startSingleStep(page, durationInput);
  const dateRun = await waitForRun(page, workspaceId, runId, 'succeeded');
  const dateNodeRun = dateRun.nodes.find((node) => node.nodeId === dateId);
  if (dateNodeRun === undefined) throw new Error('Date node run missing');
  expect(await readOutput(page, workspaceId, runId, dateNodeRun.id)).toEqual(
    preview.output,
  );
  const proof = await request.post(`${origin}/evidence/transform-date`, {
    data: {
      workspaceId,
      workflowId,
      workflowVersionId: version.id,
      runId,
      dateId,
      previewId: preview.id,
      initialPreviewId: initialPreview.id,
      formatPreviewId: formatPreview.id,
      durationPreviewId: durationPreview.id,
    },
  });
  expect(proof.status()).toBe(204);
});
