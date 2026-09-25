import { expect, test } from '@playwright/test';
import {
  addCsrfCookie,
  definition,
  editorNode,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from './workflow-editor-support';

const forEachDefinition = {
  ...definition,
  definition: { key: 'core.foreach', version: 1 },
  family: 'logic',
  configSchema: { type: 'object', properties: {} },
};

test('draws For each as a container and inspects it from the keyboard', async ({
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
        structured: {
          kind: 'for_each',
          maxIterations: 100,
          maxConcurrency: 5,
          body: {
            schemaVersion: 1,
            nodes: [
              editorNode('check', 'Check stock', 'a', 0),
              editorNode('reserve', 'Reserve item', 'b', 0),
            ],
            edges: [],
            settings: {},
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
          },
        },
      },
      editorNode('after', 'After the loop', 'c', 520),
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
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [forEachDefinition, definition],
  });
  await page.goto(editorUrl);

  const loop = page.getByTestId('rf__node-loop');
  const body = loop.getByRole('region', { name: 'Body, runs once per item' });
  await expect(body).toContainText('Check stock');
  await expect(body).toContainText('Reserve item');
  await expect(body).toContainText('item · ordinal');
  await expect(loop).toContainText('up to 100 items');
  await expect(loop).toContainText('5 at a time');
  await expect(loop.getByLabel('Each order: output done')).toBeVisible();
  const loopBox = await loop.boundingBox();
  const stepBox = await page.getByTestId('rf__node-after').boundingBox();
  expect(loopBox?.width ?? 0).toBeGreaterThan(stepBox?.width ?? 0);

  await loop.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
    'Each order',
  );
  await expect(
    page.getByRole('region', { name: 'Runs once per item' }),
  ).toContainText('up to 100 items and 5 at a time');
  expect(remote.revision).toBe(1);
});
