import { expect, type Page } from '@playwright/test';
import {
  strongEtagSchema,
  workflowDraftResponseSchema,
} from '@pertexo/contracts';
import { addSingleStep, readEditorDraft } from './single-step';

export async function readTaggedExpressionDraft(
  page: Page,
  workflowPath: string,
) {
  const response = await page.request.get(`${workflowPath}/draft`);
  expect(response.status()).toBe(200);
  return {
    draft: workflowDraftResponseSchema.parse(await response.json()),
    etag: strongEtagSchema.parse(response.headers().etag),
  };
}

/** One loop and one leaf, authored through ordinary controls, never API seeding. */
export async function authorNestedExpressionGraph(
  page: Page,
  workflowPath: string,
) {
  const loopId = await addSingleStep(
    page,
    workflowPath,
    /For each/u,
    'Expression loop',
  );
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page.getByLabel('Items at a time', { exact: true }).fill('1');
  await page.keyboard.press('Tab');
  await page.getByLabel('Maximum items', { exact: true }).fill('1');
  await page.keyboard.press('Tab');
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  await page.getByLabel('Field', { exact: true }).fill('items');
  await page.getByRole('button', { name: 'Run input', exact: true }).click();
  await page.getByLabel('Run input path', { exact: true }).fill('$.items');
  await page.keyboard.press('Tab');
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add step to body', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Set fields/u })
    .click();
  const leafFromDraft = async () =>
    (await readEditorDraft(page, workflowPath)).graph.nodes[0]?.structured?.body
      .nodes[0];
  await expect
    .poll(async () => (await leafFromDraft())?.definition.key)
    .toBe('core.set');
  const leaf = await leafFromDraft();
  if (leaf === undefined)
    throw new Error('Browser-created expression leaf missing');
  await page.getByTestId(`rf__node-${leaf.id}`).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Label', { exact: true }).fill('Expression leaf');
  await page.keyboard.press('Tab');
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const inputs = page.getByRole('region', { name: 'Inputs', exact: true });
  let row = inputs.locator('ol > li').last();
  await row.getByLabel('Field', { exact: true }).fill('item');
  await row.getByRole('button', { name: 'Loop item', exact: true }).click();
  await row.getByLabel('Path in it', { exact: true }).fill('$');
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  row = inputs.locator('ol > li').last();
  await row.getByLabel('Field', { exact: true }).fill('expressionProof');
  await row.getByRole('button', { name: 'Expression', exact: true }).click();
  await row.getByLabel('Expression', { exact: true }).fill('(');
  await page.keyboard.press('Tab');
  await expect
    .poll(async () => (await leafFromDraft())?.inputMappings)
    .toEqual({
      item: { kind: 'structured_input', port: 'item', path: '$' },
      expressionProof: {
        kind: 'expression',
        language: 'jsonata',
        expression: '(',
        policyVersion: 1,
      },
    });
  return {
    loopId,
    leafId: leaf.id,
    ...(await readTaggedExpressionDraft(page, workflowPath)),
  };
}
