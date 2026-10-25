import { expect, type Page } from '@playwright/test';
import { mapBrowserInput } from '../../../test/support/browser/inputs';
import { readEditorDraft } from './single-step';

/** Ordinary inspector edits and wiring, never a seeded graph/save request. */
export async function authorWebhookHttpGraph(
  page: Page,
  workflowPath: string,
  readDraft: typeof readEditorDraft = readEditorDraft,
  terminalStop = false,
) {
  const webhookId = await add(/Webhook/u, 'Signed input');
  async function add(kind: RegExp, label: string) {
    const before = (await readDraft(page, workflowPath)).graph.nodes;
    await page
      .getByRole('complementary', { name: 'Add a step' })
      .getByRole('button', { name: kind })
      .click();
    await expect
      .poll(
        async () => (await readDraft(page, workflowPath)).graph.nodes.length,
      )
      .toBe(before.length + 1);
    const node = (await readDraft(page, workflowPath)).graph.nodes.find(
      (candidate) => !before.some(({ id }) => id === candidate.id),
    );
    if (node === undefined)
      throw new Error('Browser-authored HTTP step missing');
    await page.getByTestId(`rf__node-${node.id}`).focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Label', { exact: true }).fill(label);
    await page.keyboard.press('Tab');
    return node.id;
  }
  async function connect(label: string, output = 'out') {
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await page
      .getByRole('button', { name: 'Link a step', exact: true })
      .click();
    for (const [field, choice] of [
      ['Link from step', label],
      ['From output', output],
      ['Into input', 'in'],
    ] as const) {
      await page.getByLabel(field, { exact: true }).click();
      await page.getByRole('option', { name: choice, exact: true }).click();
    }
    await page.getByRole('button', { name: 'Link', exact: true }).click();
  }

  const validateId = await add(/Validate/u, 'Check signed input');
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page.getByRole('button', { name: 'Edit as JSON', exact: true }).click();
  await page.getByLabel('Setup as JSON', { exact: true }).fill(
    JSON.stringify({
      rules: [
        { id: 'execute', path: '$.execute', required: true, type: 'boolean' },
      ],
    }),
  );
  await page.keyboard.press('Tab');
  await connect('Signed input');
  await mapBrowserInput({
    page,
    scope: page,
    field: 'execute',
    source: 'Signed input',
    path: '$.execute',
  });
  const mapId = await add(/Set fields/u, 'Mapped action input');
  await connect('Check signed input');
  await mapBrowserInput({
    page,
    scope: page,
    field: 'condition',
    source: 'Run input',
    path: '$.execute',
  });
  const conditionId = await add(/Condition/u, 'Should send');
  await connect('Mapped action input');
  await mapBrowserInput({
    page,
    scope: page,
    field: 'condition',
    source: 'Mapped action input',
    path: '$.condition',
  });
  const httpId = await add(/HTTP request/u, 'Owned HTTP effect');
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page.getByRole('button', { name: 'Edit as JSON', exact: true }).click();
  await page.getByLabel('Setup as JSON', { exact: true }).fill(
    JSON.stringify({
      method: 'POST',
      url: 'https://pertexo-controlled-action.example.test/effect',
      headers: { 'content-type': 'application/json' },
      timeoutMillis: 5000,
      maxRedirects: 0,
      maxResponseBytes: 4096,
      inlineResponseBytes: 4096,
    }),
  );
  await page.keyboard.press('Tab');
  // Select the actual encrypted connection created through the ordinary UI.
  await page.getByLabel('HTTP connection', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Owned HTTP credential', exact: true })
    .click();
  await connect('Should send', 'true');
  await mapBrowserInput({
    page,
    scope: page,
    field: 'body',
    source: 'Run input',
    path: '$.body',
  });
  // Palette placement already saved the last link; wait for the final input edit.
  await expect
    .poll(
      async () =>
        (await readDraft(page, workflowPath)).graph.nodes.find(
          ({ id }) => id === httpId,
        )?.inputMappings,
    )
    .toEqual({ body: { kind: 'run_input', path: '$.body' } });
  await expect
    .poll(async () => (await readDraft(page, workflowPath)).graph.edges.length)
    .toBe(4);
  const stopId = terminalStop
    ? await add(/^Stop run\b/u, 'Finished action')
    : undefined;
  if (stopId !== undefined) {
    await connect('Owned HTTP effect');
    await expect
      .poll(
        async () =>
          (await readDraft(page, workflowPath)).graph.nodes.find(
            (node) => node.id === stopId,
          )?.label,
      )
      .toBe('Finished action');
  }
  await expect
    .poll(async () => (await readDraft(page, workflowPath)).graph.edges.length)
    .toBe(terminalStop ? 5 : 4);
  const graph = (await readDraft(page, workflowPath)).graph;
  expect(graph.nodes).toHaveLength(terminalStop ? 6 : 5);
  return { webhookId, validateId, mapId, conditionId, httpId, stopId, graph };
}
