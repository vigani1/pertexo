import { dataTableConfigSchema } from '@pertexo/node-sdk';
import { expect, type Page } from '@playwright/test';
import {
  dataTableResultSchema,
  workflowNodeRunOutputResponseSchema,
  workflowPublishResponseSchema,
  workflowVersionsResponseSchema,
} from '@pertexo/contracts';
import {
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';

export async function qualifyColumnNames({
  page,
  workspaceId,
  workflow,
  nodeId,
  originalVersionId,
  width,
}: Readonly<{
  page: Page;
  workspaceId: string;
  workflow: string;
  nodeId: string;
  originalVersionId: string;
  width: number;
}>) {
  await page.setViewportSize({ width, height: 768 });
  await page.goto(workflow.replace('/v1/workspaces/', '/w/'));
  await page.getByTestId(`rf__node-${nodeId}`).click();
  if (width < 1024)
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  const fields = page.getByRole('region', { name: 'Table column bindings' });
  await expect(fields).toContainText('amount (now called total)');
  const original = (await readEditorDraft(page, workflow)).graph.nodes.find(
    (node) => node.id === nodeId,
  );
  if (original === undefined) throw new Error('Original table step missing');
  const bindings = dataTableConfigSchema.parse(original.config).columnBindings;
  if (bindings?.amount === undefined)
    throw new Error('Original amount binding missing');
  const { amount, ...unchanged } = bindings;
  await fields
    .getByRole('button', { name: 'Use the new name', exact: true })
    .click();
  const review = page.getByRole('dialog', { name: 'Review column names' });
  await expect(review).toContainText('amount');
  await expect(review).toContainText('total');
  await page.screenshot({
    path: `/tmp/pertexo-live-column-names-${String(width)}.png`,
  });
  await review
    .getByRole('button', { name: 'Use the new name', exact: true })
    .click();
  await expect(review).not.toBeVisible();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflow)).graph.nodes.find(
          (node) => node.id === nodeId,
        )?.config.columnBindings,
    )
    .toEqual({ ...unchanged, total: amount });
  await page.getByRole('button', { name: 'Publish v2', exact: true }).click();
  const response = page.waitForResponse(
    (result) =>
      result.request().method() === 'POST' &&
      result.url().endsWith(`${workflow}/publish`),
  );
  await page
    .getByRole('dialog', { name: 'Publish v2', exact: true })
    .getByRole('button', { name: 'Publish v2', exact: true })
    .click();
  const publishedResponse = await response;
  expect(publishedResponse.status()).toBe(200);
  const published = workflowPublishResponseSchema.parse(
    await publishedResponse.json(),
  );
  expect(published.version.versionNumber).toBe(2);
  await expect(page.getByText('v2 is live', { exact: true })).toBeVisible();
  const versions = await page.request.get(`${workflow}/versions`);
  expect(
    workflowVersionsResponseSchema
      .parse(await versions.json())
      .items.find((version) => version.id === originalVersionId)
      ?.graph.nodes.find((node) => node.id === nodeId)?.config.columnBindings,
  ).toMatchObject({ amount: 'amount' });
  const runId = await startSingleStep(page, {});
  const run = await waitForRun(page, workspaceId, runId, 'succeeded');
  const node = run.nodes.find((entry) => entry.nodeId === nodeId);
  if (node === undefined) throw new Error('Adopted Find output missing');
  const outputResponse = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${node.id}/output`,
  );
  expect(outputResponse.status()).toBe(200);
  const output = workflowNodeRunOutputResponseSchema.parse(
    await outputResponse.json(),
  ).output;
  if (output.kind !== 'inline')
    throw new Error('Expected inline adopted result');
  expect(
    dataTableResultSchema
      .parse(output.value)
      .rows.find((row) => row.values.key === 'alpha')?.values,
  ).toEqual({ key: 'alpha', total: 20, currency: 'USD' });
  return published.version.id;
}
