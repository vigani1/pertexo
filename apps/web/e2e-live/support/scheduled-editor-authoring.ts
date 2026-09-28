import { expect, type Locator, type Page } from '@playwright/test';
import {
  scheduleFireTimesResponseSchema,
  schedulePreviewRequestSchema,
} from '@pertexo/contracts/schemas/schedules';
import { addSingleStep, readEditorDraft } from './single-step-authoring';

/** Uses ordinary inspector controls; requests only observe the saved graph. */
export async function authorScheduledNestedGraph(
  page: Page,
  workflowPath: string,
) {
  const draft = () => readEditorDraft(page, workflowPath);
  const scheduleId = await addSingleStep(
    page,
    workflowPath,
    /Schedule/u,
    'Minute schedule',
  );
  await page.getByLabel('Runs', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Every N minutes or hours', exact: true })
    .click();
  const previewPending = page.waitForResponse(
    (response) => {
      if (
        response.request().method() !== 'POST' ||
        new URL(response.url()).pathname !==
          `${workflowPath}/triggers/schedules/preview`
      )
        return false;
      const body: unknown = response.request().postDataJSON();
      const parsed = schedulePreviewRequestSchema.safeParse(body);
      return (
        parsed.success &&
        parsed.data.config.kind === 'interval' &&
        parsed.data.config.intervalMinutes === 1
      );
    },
    { timeout: 10_000 },
  );
  await page.getByLabel('Every', { exact: true }).fill('1');
  await page.keyboard.press('Tab');
  await page
    .getByRole('group', { name: 'Unit', exact: true })
    .getByRole('button', { name: 'minutes', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'If runs are missed', exact: true })
    .getByRole('button', { name: 'Run the latest', exact: true })
    .click();
  const previewResponse = await previewPending;
  const previewBody: unknown = await previewResponse.json();
  const problemCode =
    typeof previewBody === 'object' &&
    previewBody !== null &&
    'code' in previewBody &&
    typeof previewBody.code === 'string' &&
    /^[a-z0-9_.]{1,128}$/u.test(previewBody.code)
      ? previewBody.code
      : 'no_safe_problem_code';
  expect(
    previewResponse.status(),
    `Draft schedule preview: ${problemCode}`,
  ).toBe(200);
  const preview = scheduleFireTimesResponseSchema.parse(previewBody);
  expect(preview.items).toHaveLength(3);
  expect(Date.parse(preview.items[0]?.scheduledAt ?? '')).toBeGreaterThan(
    Date.parse(preview.observedAt),
  );
  for (let index = 1; index < preview.items.length; index++)
    expect(
      Date.parse(preview.items[index]?.scheduledAt ?? '') -
        Date.parse(preview.items[index - 1]?.scheduledAt ?? ''),
    ).toBe(60_000);
  await expect
    .poll(
      async () =>
        (await draft()).graph.nodes.find((node) => node.id === scheduleId)
          ?.config,
    )
    .toEqual({
      kind: 'interval',
      intervalMinutes: 1,
      misfirePolicy: 'catch_up_once',
    });

  async function inspect(id: string, name: string) {
    await page.getByTestId(`rf__node-${id}`).focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Label', { exact: true }).fill(name);
    await page.keyboard.press('Tab');
  }
  async function limits() {
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.getByLabel('Maximum items', { exact: true }).fill('2');
    await page.keyboard.press('Tab');
    await page.getByLabel('Items at a time', { exact: true }).fill('1');
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
  async function body(kind: RegExp) {
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page
      .getByRole('button', { name: 'Add step to body', exact: true })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: kind }).click();
  }
  await page
    .getByRole('complementary', { name: 'Add a step' })
    .getByRole('button', { name: /For each/u })
    .click();
  await expect.poll(async () => (await draft()).graph.nodes.length).toBe(2);
  const outer = (await draft()).graph.nodes.find(
    (node) => node.definition.key === 'core.foreach',
  );
  if (outer === undefined)
    throw new Error('Saved scheduled outer loop missing');
  await inspect(outer.id, 'Outer scheduled items');
  await limits();
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page
    .getByRole('button', { name: 'Connect a step', exact: true })
    .click();
  await page.getByLabel('Connect from step', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Minute schedule', exact: true })
    .click();
  await page.getByLabel('From output', { exact: true }).click();
  await page.getByRole('option', { name: 'out', exact: true }).click();
  await page.getByLabel('Into input', { exact: true }).click();
  await page.getByRole('option', { name: 'in', exact: true }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await input('items', async (row) => {
    await row
      .getByLabel('JSON value', { exact: true })
      .fill('[["north-0","north-1"],["south-0","south-1"]]');
  });
  await body(/For each/u);
  const innerFromDraft = async () =>
    (await draft()).graph.nodes.find((node) => node.id === outer.id)?.structured
      ?.body.nodes[0];
  await expect
    .poll(async () => (await innerFromDraft())?.definition.key)
    .toBe('core.foreach');
  const inner = await innerFromDraft();
  if (inner === undefined)
    throw new Error('Saved scheduled inner loop missing');
  await inspect(inner.id, 'Inner scheduled items');
  await limits();
  await input('items', async (row) => {
    await row.getByRole('button', { name: 'Loop item', exact: true }).click();
    await row.getByLabel('Path in it', { exact: true }).fill('$');
  });
  await body(/Set fields/u);
  const leafFromDraft = async () =>
    (await innerFromDraft())?.structured?.body.nodes[0];
  await expect
    .poll(async () => (await leafFromDraft())?.definition.key)
    .toBe('core.set');
  const leaf = await leafFromDraft();
  if (leaf === undefined) throw new Error('Saved scheduled transform missing');
  await inspect(leaf.id, 'Scheduled leaf proof');
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
  const savedOuter = graph.nodes.find((node) => node.id === outer.id);
  expect(savedOuter?.structured).toMatchObject({
    maxIterations: 2,
    maxConcurrency: 1,
  });
  expect(savedOuter?.inputMappings).toEqual({
    items: {
      kind: 'literal',
      value: [
        ['north-0', 'north-1'],
        ['south-0', 'south-1'],
      ],
    },
  });
  expect(savedOuter?.structured?.body.nodes[0]).toMatchObject({
    id: inner.id,
    structured: { maxIterations: 2, maxConcurrency: 1 },
  });
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]).toMatchObject({
    source: { nodeId: scheduleId },
    target: { nodeId: outer.id },
  });
  return {
    scheduleId,
    outerId: outer.id,
    innerId: inner.id,
    leafId: leaf.id,
    graph,
  };
}
