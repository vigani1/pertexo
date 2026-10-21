import { expect } from '@playwright/test';
import {
  workflowTestAcceptedSchema,
  workflowTestDetailSchema,
  workflowRunListResponseSchema,
} from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import { createOwnedHttpConnection } from '../../support/authoring/http-connection';
import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
} from '../../support/authoring/single-step';

test('keeps file pages authorized in previews and draft test history without allowing file pins', async ({
  page,
  request,
}) => {
  const { workspaceId } = await createOwnedHttpConnection(page, request);
  const workflow = await createEditorWorkflow(
    page,
    workspaceId,
    'Page test history',
  );
  await addSingleStep(page, workflow, /Read file/u, 'Page CSV');
  await page.getByRole('combobox', { name: 'Output', exact: true }).click();
  await page.getByRole('option', { name: 'Output pages', exact: true }).click();
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page
    .getByRole('button', { name: 'Upload file to read', exact: true })
    .click();
  await page.getByLabel('File', { exact: true }).setInputFiles({
    name: 'totals.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('currency,amount\nEUR,20\nUSD,9\n'),
  });
  await expect(page.getByText('File ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use file', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflow)).graph.nodes[0]?.inputMappings
          .file,
    )
    .toMatchObject({ kind: 'literal', value: { kind: 'artifact' } });
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page.getByLabel('Sample input (JSON)', { exact: true }).fill('{}');
  await page.getByRole('button', { name: 'Check setup', exact: true }).click();
  await expect(
    page.getByText('Setup looks right', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Run (?:another )?test$/u }).click();
  await expect(page.getByRole('region', { name: 'Data pages' })).toContainText(
    '2 records · 1 page',
  );
  await page
    .getByRole('button', { name: 'Pin test output…', exact: true })
    .click();
  const pin = page.getByRole('dialog', { name: 'Pin sample output' });
  await pin.getByRole('button', { name: 'Pin output', exact: true }).click();
  await expect(pin).toContainText('file references cannot be pinned');
  await pin.getByRole('button', { name: 'Close', exact: true }).click();
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Test workflow', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Test workflow',
    exact: true,
  });
  await dialog.getByLabel('Test input (JSON)', { exact: true }).fill('{}');
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`${workflow}/draft/tests`),
  );
  await dialog.getByRole('button', { name: 'Start test', exact: true }).click();
  const runId = workflowTestAcceptedSchema.parse(
    await (await accepted).json(),
  ).runId;
  await expect
    .poll(
      async () =>
        workflowTestDetailSchema.parse(
          await (
            await page.request.get(`${workflow}/draft/tests/${runId}`)
          ).json(),
        ).status,
      { timeout: 30000 },
    )
    .toBe('succeeded');
  await page.reload();
  await page
    .getByRole('button', { name: 'More test actions', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'Test history', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Workflow tests' }),
  ).toContainText('Succeeded');
  const ordinary = workflowRunListResponseSchema.parse(
    await (await page.request.get(`/v1/workspaces/${workspaceId}/runs`)).json(),
  );
  expect(ordinary.items.some((run) => run.id === runId)).toBe(false);
});
