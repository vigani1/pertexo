import { expect, test } from '@playwright/test';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  mappingGraph,
  remoteDraft,
} from './workflow-editor-support';

test('drops a connection on empty canvas to add a connected step there, undone in one step', async ({
  context,
  page,
}) => {
  const remote = remoteDraft(mappingGraph());
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  const output = page
    .getByTestId('rf__node-target')
    .locator('.react-flow__handle.source');
  const box = await output.boundingBox();
  if (box === null) throw new Error('The output port is not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 140, { steps: 10 });
  await page.mouse.up();

  const lens = page.getByRole('dialog', { name: 'Add a step after “Target”' });
  await expect(lens).toBeVisible();
  await expect(
    lens.getByRole('searchbox', { name: 'Search steps' }),
  ).toBeFocused();
  await expect(lens.getByRole('button', { name: /Manual start/u })).toHaveCount(
    0,
  );
  await lens.getByRole('button', { name: /Set fields/u }).click();
  await expect(lens).toBeHidden();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect
    .poll(() => remote.graph.edges.length, { timeout: 4_000 })
    .toBe(2);
  expect(remote.graph.edges[1]).toMatchObject({
    source: { nodeId: 'target', port: 'out' },
    target: { port: 'in' },
  });

  await page.getByRole('button', { name: 'Undo' }).first().click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect
    .poll(() => remote.graph.nodes.length, { timeout: 4_000 })
    .toBe(2);
  expect(remote.graph.edges).toHaveLength(1);
});

test('adds a step after the selected one from the keyboard', async ({
  context,
  page,
}) => {
  const remote = remoteDraft(mappingGraph());
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-target').focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('button', { name: 'Step actions' });
  await menu.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Add step after' }).focus();
  await page.keyboard.press('Enter');

  const lens = page.getByRole('dialog', { name: 'Add a step after “Target”' });
  const search = lens.getByRole('searchbox', { name: 'Search steps' });
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(lens).toBeHidden();
  await expect(menu).toBeFocused();

  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Add step after' }).focus();
  await page.keyboard.press('Enter');
  await expect(search).toBeFocused();
  await page.keyboard.type('set');
  await lens.getByRole('button', { name: /Set fields/u }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect
    .poll(() => remote.graph.edges.length, { timeout: 4_000 })
    .toBe(2);
  expect(remote.graph.edges[1]).toMatchObject({
    source: { nodeId: 'target', port: 'out' },
  });
});
