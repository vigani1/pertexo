import { expect, test, type Page } from '@playwright/test';
import {
  addCsrfCookie,
  definition,
  editorNode,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  type RemoteDraft,
} from './workflow-editor-support';

const forEachDefinition = {
  ...definition,
  definition: { key: 'core.foreach', version: 1 },
  family: 'logic',
  configSchema: { type: 'object', properties: {} },
};

type BodyGraph = Readonly<{
  nodes: readonly Readonly<{
    id: string;
    position: Readonly<{ x: number; y: number }>;
    inputMappings: Readonly<Record<string, unknown>>;
  }>[];
  edges: readonly Readonly<{
    source: Readonly<{ nodeId: string }>;
    target: Readonly<{ nodeId: string }>;
  }>[];
}>;

/** Each order (check → reserve), then After the loop. */
function orderLoopDraft(): RemoteDraft {
  return remoteDraft({
    schemaVersion: 1,
    nodes: [
      {
        ...editorNode('loop', 'Each order', 'unused', 80),
        definition: { key: 'core.foreach', version: 1 },
        config: {},
        structured: {
          kind: 'for_each',
          maxIterations: 100,
          maxConcurrency: 5,
          body: {
            schemaVersion: 1,
            nodes: [
              editorNode('check', 'Check stock', 'a', 0),
              editorNode('reserve', 'Reserve item', 'b', 300),
            ],
            edges: [
              {
                id: 'check-reserve',
                source: { nodeId: 'check', port: 'out' },
                target: { nodeId: 'reserve', port: 'in' },
              },
            ],
            settings: {},
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
          },
        },
      },
      editorNode('after', 'After the loop', 'c', 900),
    ],
    edges: [
      {
        id: 'loop-after',
        source: { nodeId: 'loop', port: 'out' },
        target: { nodeId: 'after', port: 'in' },
      },
    ],
    settings: {},
  });
}

function savedBody(remote: RemoteDraft): BodyGraph | undefined {
  const loop = remote.graph.nodes.find(
    (node) => (node as { id?: unknown }).id === 'loop',
  ) as { structured?: { body: BodyGraph } } | undefined;
  return loop?.structured?.body;
}

async function openEditor(page: Page, remote: RemoteDraft) {
  await installEditorRoutes(page, remote, {
    definitions: [forEachDefinition, definition],
  });
  await page.goto(editorUrl);
}

test('draws For each as a container with its body steps inside and inspects it from the keyboard', async ({
  context,
  page,
}) => {
  const remote = orderLoopDraft();
  await addCsrfCookie(context);
  await openEditor(page, remote);

  const loop = page.getByTestId('rf__node-loop');
  const body = loop.getByRole('region', { name: 'Body, runs once per item' });
  await expect(body).toContainText('item · ordinal');
  await expect(loop).toContainText('up to 100 items');
  await expect(loop).toContainText('5 at a time');
  await expect(loop.getByLabel('Each order: output done')).toBeVisible();
  const check = page.getByTestId('rf__node-check');
  const reserve = page.getByTestId('rf__node-reserve');
  await expect(check).toContainText('Check stock');
  await expect(reserve).toContainText('Gives the result');
  const loopBox = await loop.boundingBox();
  const reserveBox = await reserve.boundingBox();
  const stepBox = await page.getByTestId('rf__node-after').boundingBox();
  expect(loopBox?.width ?? 0).toBeGreaterThan(stepBox?.width ?? 0);
  // Body steps are drawn inside their container.
  expect(reserveBox?.x ?? 0).toBeGreaterThan(loopBox?.x ?? 0);
  expect((reserveBox?.x ?? 0) + (reserveBox?.width ?? 0)).toBeLessThan(
    (loopBox?.x ?? 0) + (loopBox?.width ?? 0),
  );
  await expect(page.getByTestId('rf__edge-check-reserve')).toBeAttached();

  await loop.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
    'Each order',
  );
  const section = page.getByRole('region', {
    name: 'Runs once per item',
    exact: true,
  });
  await expect(section).toContainText('up to 100 items and 5 at a time');
  await expect(
    section.getByRole('list', { name: 'Body steps' }).getByRole('button'),
  ).toHaveText(['Check stock', 'Reserve item']);
  expect(remote.revision).toBe(1);
});

test('builds a body from the keyboard: adds after its last step, maps the item, deletes with Undo', async ({
  context,
  page,
}) => {
  const remote = orderLoopDraft();
  await addCsrfCookie(context);
  await openEditor(page, remote);

  await page.getByTestId('rf__node-loop').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Add step to body' }).focus();
  await page.keyboard.press('Enter');
  const lens = page.getByRole('dialog', {
    name: 'Add a step after “Reserve item”',
  });
  await expect(
    lens.getByRole('searchbox', { name: 'Search steps' }),
  ).toBeFocused();
  await page.keyboard.type('set');
  await lens.getByRole('button', { name: /Set fields/u }).focus();
  await page.keyboard.press('Enter');
  await expect(lens).toBeHidden();
  await expect
    .poll(() => savedBody(remote)?.nodes.length, { timeout: 4_000 })
    .toBe(3);
  expect(savedBody(remote)?.edges.at(-1)).toMatchObject({
    source: { nodeId: 'reserve' },
  });
  expect(remote.graph.nodes).toHaveLength(2);

  await page.getByTestId('rf__node-check').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
    'Check stock',
  );
  await page.getByRole('tab', { name: 'Inputs' }).click();
  await page.getByRole('button', { name: 'Insert data' }).click();
  const picker = page.getByRole('dialog', { name: 'Insert data' });
  await expect(picker).toContainText('This item');
  await picker.getByRole('button', { name: /Whole item/u }).click();
  await expect(page.getByRole('button', { name: 'Loop item' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() => savedBody(remote)?.nodes[0]?.inputMappings, {
      timeout: 4_000,
    })
    .toEqual({ item: { kind: 'structured_input', port: 'item', path: '$' } });

  await page.getByTestId('rf__node-check').focus();
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('rf__node-check')).toBeHidden();
  await expect(page.getByText('Deleted “Check stock”')).toBeVisible();
  // The notification's Undo comes after the command bar's in the page.
  await page.getByRole('button', { name: 'Undo' }).last().click();
  await expect(page.getByTestId('rf__node-check')).toBeVisible();
  await expect
    .poll(() => savedBody(remote)?.nodes.map((node) => node.id), {
      timeout: 4_000,
    })
    .toEqual(expect.arrayContaining(['check', 'reserve']));
});

test('adds a first body step from the container and never connects across the body’s edge', async ({
  context,
  page,
}) => {
  const remote = remoteDraft({
    schemaVersion: 1,
    nodes: [
      {
        ...editorNode('loop', 'Each order', 'unused', 80),
        definition: { key: 'core.foreach', version: 1 },
        config: {},
      },
      editorNode('after', 'After the loop', 'c', 700),
    ],
    edges: [],
    settings: {},
  });
  await addCsrfCookie(context);
  await openEditor(page, remote);

  const loop = page.getByTestId('rf__node-loop');
  await expect(
    loop.getByRole('list', { name: 'What the body needs' }),
  ).toContainText('The body is empty.');
  await loop
    .getByRole('button', { name: 'Add a step to Each order’s body' })
    .click();
  const lens = page.getByRole('dialog', {
    name: 'Add a step to “Each order”',
  });
  await lens.getByRole('button', { name: /Set fields/u }).click();
  await expect(
    loop.getByRole('list', { name: 'What the body needs' }),
  ).toBeHidden();
  await expect
    .poll(() => savedBody(remote)?.nodes.length, { timeout: 4_000 })
    .toBe(1);
  const inner = savedBody(remote)?.nodes[0]?.id ?? '';

  // A connection from outside the body to a step inside it is refused.
  const from = page
    .getByTestId('rf__node-after')
    .locator('.react-flow__handle.source');
  const to = page
    .getByTestId(`rf__node-${inner}`)
    .locator('.react-flow__handle.target');
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (start === null || end === null) throw new Error('Ports are off screen');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  expect(remote.graph.edges).toEqual([]);
  expect(savedBody(remote)?.edges).toEqual([]);
});
