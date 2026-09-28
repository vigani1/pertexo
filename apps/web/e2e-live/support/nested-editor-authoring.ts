import { expect, type Locator, type Page } from '@playwright/test';
import {
  workflowDraftResponseSchema,
  type WorkflowDraftResponse,
} from '@pertexo/contracts/schemas/workflow-authoring';

/** Browser authoring only; request calls observe saved state, never seed graphs. */
export async function authorNestedMappingGraph(page: Page, draftPath: string) {
  async function draft() {
    const response = await page.request.get(draftPath);
    expect(response.status()).toBe(200);
    return workflowDraftResponseSchema.parse(await response.json());
  }
  async function inspect(nodeId: string, label: string) {
    await page.getByTestId(`rf__node-${nodeId}`).focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Label', { exact: true }).fill(label);
    await page.keyboard.press('Tab');
  }
  async function input(key: string, source: (row: Locator) => Promise<void>) {
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await page.getByRole('button', { name: 'Add input', exact: true }).click();
    const row = page
      .getByRole('region', { name: 'Inputs', exact: true })
      .locator('ol > li')
      .last();
    await row.getByLabel('Field', { exact: true }).fill(key);
    await source(row);
    await page.keyboard.press('Tab');
  }
  async function limits() {
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.getByLabel('Items at a time', { exact: true }).fill('2');
    await page.keyboard.press('Tab');
    await page.getByLabel('Maximum items', { exact: true }).fill('2');
    await page.keyboard.press('Tab');
  }
  async function addBodyStep(kind: RegExp) {
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page
      .getByRole('button', { name: 'Add step to body', exact: true })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: kind }).click();
  }
  const palette = page.getByRole('complementary', { name: 'Add a step' });
  await palette.getByRole('button', { name: /Set fields/u }).click();
  await expect.poll(async () => (await draft()).graph.nodes.length).toBe(1);
  const root = (await draft()).graph.nodes[0];
  if (root === undefined) throw new Error('Saved root step missing');
  await inspect(root.id, 'Mapping source');
  await input('literalProof', async (row) => {
    await row
      .getByLabel('JSON value', { exact: true })
      .fill('"from-real-browser"');
  });
  await input('matrix', async (row) => {
    await row.getByRole('button', { name: 'Run input', exact: true }).click();
    await row.getByLabel('Run input path', { exact: true }).fill('$.groups');
  });
  await input('expressionProof', async (row) => {
    await row.getByRole('button', { name: 'Expression', exact: true }).click();
    await row
      .getByLabel('Expression', { exact: true })
      .fill('runInput.amount > 5000');
  });
  await input('missingProof', async (row) => {
    await row.getByRole('button', { name: 'Run input', exact: true }).click();
    await row
      .getByLabel('Run input path', { exact: true })
      .fill('$.notProvided');
  });
  const rootMappings = {
    literalProof: { kind: 'literal', value: 'from-real-browser' },
    matrix: { kind: 'run_input', path: '$.groups' },
    expressionProof: {
      kind: 'expression',
      language: 'jsonata',
      expression: 'runInput.amount > 5000',
      policyVersion: 1,
    },
    missingProof: { kind: 'run_input', path: '$.notProvided' },
  } satisfies WorkflowDraftResponse['graph']['nodes'][number]['inputMappings'];
  await expect
    .poll(async () => (await draft()).graph.nodes[0]?.inputMappings)
    .toEqual(rootMappings);
  await palette.getByRole('button', { name: /For each/u }).click();
  await expect.poll(async () => (await draft()).graph.nodes.length).toBe(2);
  const outer = (await draft()).graph.nodes.find(
    (node) => node.definition.key === 'core.foreach',
  );
  if (outer === undefined) throw new Error('Saved outer loop missing');
  await inspect(outer.id, 'Outer items');
  await limits();
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page
    .getByRole('button', { name: 'Connect a step', exact: true })
    .click();
  await page.getByLabel('Connect from step', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Mapping source', exact: true })
    .click();
  await page.getByLabel('From output', { exact: true }).click();
  await page.getByRole('option', { name: 'out', exact: true }).click();
  await page.getByLabel('Into input', { exact: true }).click();
  await page.getByRole('option', { name: 'in', exact: true }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await input('items', async (row) => {
    await row.getByRole('button', { name: 'Step output', exact: true }).click();
    await row.getByLabel('Output path', { exact: true }).fill('$.matrix');
  });
  await addBodyStep(/For each/u);
  await expect
    .poll(
      async () =>
        (await draft()).graph.nodes.find((node) => node.id === outer.id)
          ?.structured?.body.nodes.length,
    )
    .toBe(1);
  const inner = (await draft()).graph.nodes.find((node) => node.id === outer.id)
    ?.structured?.body.nodes[0];
  if (inner === undefined) throw new Error('Saved inner loop missing');
  await inspect(inner.id, 'Inner items');
  await limits();
  await input('items', async (row) => {
    await row.getByRole('button', { name: 'Loop item', exact: true }).click();
    await row.getByLabel('Path in it', { exact: true }).fill('$');
  });
  await addBodyStep(/Set fields/u);
  const leafFromDraft = async () =>
    (await draft()).graph.nodes.find((node) => node.id === outer.id)?.structured
      ?.body.nodes[0]?.structured?.body.nodes[0];
  await expect
    .poll(async () => (await leafFromDraft())?.definition.key)
    .toBe('core.set');
  const leaf = await leafFromDraft();
  if (leaf === undefined) throw new Error('Saved leaf step missing');
  await inspect(leaf.id, 'Leaf proof');
  await input('item', async (row) => {
    await row.getByRole('button', { name: 'Loop item', exact: true }).click();
    await row.getByLabel('Path in it', { exact: true }).fill('$');
  });
  await input('ordinal', async (row) => {
    await row.getByRole('button', { name: 'Loop item', exact: true }).click();
    await row.getByLabel('Read', { exact: true }).click();
    await page
      .getByRole('option', { name: 'Its position (0, 1, 2…)', exact: true })
      .click();
    await row.getByLabel('Path in it', { exact: true }).fill('$');
  });
  await expect
    .poll(async () => (await leafFromDraft())?.inputMappings)
    .toEqual({
      item: { kind: 'structured_input', port: 'item', path: '$' },
      ordinal: { kind: 'structured_input', port: 'ordinal', path: '$' },
    });
  const graph = (await draft()).graph;
  expect(graph.nodes[0]?.inputMappings).toEqual(rootMappings);
  const savedOuter = graph.nodes.find((node) => node.id === outer.id);
  expect(savedOuter?.inputMappings).toEqual({
    items: { kind: 'node_output', nodeId: root.id, path: '$.matrix' },
  });
  expect(savedOuter?.structured).toMatchObject({
    maxIterations: 2,
    maxConcurrency: 2,
  });
  expect(savedOuter?.structured?.body.nodes[0]).toMatchObject({
    id: inner.id,
    inputMappings: {
      items: { kind: 'structured_input', port: 'item', path: '$' },
    },
    structured: { maxIterations: 2, maxConcurrency: 2 },
  });
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]).toMatchObject({
    source: { nodeId: root.id },
    target: { nodeId: outer.id },
  });
  return {
    rootId: root.id,
    outerId: outer.id,
    innerId: inner.id,
    leafId: leaf.id,
    graph,
  };
}
