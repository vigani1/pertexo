import { expect, type Page } from '@playwright/test';
import { readEditorDraft } from './single-step';

/** Shared ordinary UI actions; the mock and live journeys author the same graph. */
export async function authorCollectionGraph(
  page: Page,
  workflowPath: string,
  readDraft = readEditorDraft,
) {
  const panel = page.getByRole('complementary', { name: 'Step panel' });
  async function add(name: string, label: string, predecessorId?: string) {
    if (predecessorId !== undefined) {
      await page.getByTestId(`rf__node-${predecessorId}`).focus();
      await page.keyboard.press('Enter');
    }
    const before = (await readDraft(page, workflowPath)).graph.nodes;
    await page
      .getByRole('complementary', { name: 'Add a step' })
      .getByRole('button', { name: new RegExp(`^${name}\\b`, 'u') })
      .click();
    await expect
      .poll(
        async () => (await readDraft(page, workflowPath)).graph.nodes.length,
      )
      .toBe(before.length + 1);
    const saved = (await readDraft(page, workflowPath)).graph;
    const created = saved.nodes.find(
      (node) => !before.some((old) => old.id === node.id),
    );
    if (created === undefined)
      throw new Error('Browser-authored transform missing');
    if (predecessorId !== undefined) {
      expect(saved.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: { nodeId: predecessorId, port: 'out' },
            target: { nodeId: created.id, port: 'in' },
          }),
        ]),
      );
      const predecessor = before.find((node) => node.id === predecessorId);
      if (predecessor === undefined)
        throw new Error('Selected predecessor missing');
      expect(created.position.x).toBeGreaterThan(predecessor.position.x);
    }
    await page.getByTestId(`rf__node-${created.id}`).focus();
    await page.keyboard.press('Enter');
    await panel.getByLabel('Label', { exact: true }).fill(label);
    await page.keyboard.press('Tab');
    return created.id;
  }
  async function setup(label: string, value: string) {
    await panel.getByRole('tab', { name: 'Setup', exact: true }).click();
    await panel.getByLabel(label, { exact: true }).fill(value);
    await page.keyboard.press('Tab');
  }
  async function map(field: string, source: string, path: string) {
    await panel.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await panel.getByRole('button', { name: 'Add input', exact: true }).click();
    const row = panel
      .getByRole('region', { name: 'Inputs', exact: true })
      .locator('ol > li')
      .last();
    await row.getByLabel('Field', { exact: true }).fill(field);
    if (source === 'Run input') {
      await row.getByRole('button', { name: 'Run input', exact: true }).click();
      await row.getByLabel('Run input path', { exact: true }).fill(path);
    } else {
      await row
        .getByRole('button', { name: 'Step output', exact: true })
        .click();
      await row.getByLabel('Source step', { exact: true }).click();
      await page.getByRole('option', { name: source, exact: true }).click();
      await row.getByLabel('Output path', { exact: true }).fill(path);
    }
    await page.keyboard.press('Tab');
  }
  const manualId = await add('Manual start', 'Invoice input');
  const filterId = await add('Filter items', 'Paid invoices', manualId);
  await setup('Item path', '$.paid');
  await map('items', 'Run input', '$.invoices');
  await map('value', 'Run input', '$.paid');
  const sortId = await add('Sort items', 'Amount order', filterId);
  await setup('Sort by', '$.amount');
  await map('items', 'Paid invoices', '$.items');
  const uniqueId = await add('Remove duplicates', 'One invoice per ID', sortId);
  await setup('Compare by', '$.id');
  await map('items', 'Amount order', '$.items');
  const summaryId = await add('Summarize items', 'Currency totals', uniqueId);
  await setup('Numeric value', '$.amount');
  await setup('Group by', '$.currency');
  await map('items', 'One invoice per ID', '$.items');
  const stopId = await add('Stop run', 'Return totals', summaryId);
  await map('result', 'Currency totals', '$.groups');
  await expect
    .poll(
      async () =>
        (await readDraft(page, workflowPath)).graph.nodes.find(
          (node) => node.id === stopId,
        )?.inputMappings,
    )
    .toEqual({
      result: { kind: 'node_output', nodeId: summaryId, path: '$.groups' },
    });
  const graph = (await readDraft(page, workflowPath)).graph;
  expect(graph.edges).toHaveLength(5);
  return { graph, manualId, filterId, sortId, uniqueId, summaryId, stopId };
}

export const invoiceInput = {
  paid: true,
  invoices: [
    { id: 'a', amount: 30, currency: 'EUR', paid: true },
    { id: 'b', amount: 10, currency: 'EUR', paid: true },
    { id: 'a', amount: 30, currency: 'EUR', paid: true },
    { id: 'c', amount: 20, currency: 'USD', paid: true },
    { id: 'd', amount: 100, currency: 'EUR', paid: false },
  ],
};
export const invoiceGroups = [
  { key: 'EUR', count: 2, sum: 40, min: 10, max: 30, average: 20 },
  { key: 'USD', count: 1, sum: 20, min: 20, max: 20, average: 20 },
];
