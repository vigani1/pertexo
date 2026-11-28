import {
  nodeDefinitionListResponseSchema,
  workflowGraphSchema,
} from '@pertexo/contracts';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { expect, test, type Page } from '../../support/fixtures';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
} from '../support';
import { focusStep, openStepPalette, openWorkflowMenu } from '../actions';

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
    .locator('.react-flow__handle.source[data-handleid="out"]');
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

  await openWorkflowMenu(page);
  await page.getByRole('menuitem', { name: 'Undo' }).click();
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
  await focusStep(page, 'target');
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

test('keeps the step list the same length while it is scrolled through', async ({
  context,
  page,
}) => {
  const definitions = nodeDefinitionListResponseSchema.parse({
    items: platformBrowserNodeDefinitionCatalog().definitions,
  }).items;
  await addCsrfCookie(context);
  await installEditorRoutes(page, remoteDraft(), { definitions });
  await page.goto(editorUrl);
  await openStepPalette(page);
  const list = page
    .getByRole('complementary', { name: 'Add a step' })
    .getByRole('button', { name: /^Manual start\b/u })
    .locator('xpath=ancestor::*[contains(@class, "overflow-y-auto")][1]');
  await expect(list).toBeVisible();
  // Rows drawn only as they scroll in must arrive at the size they were
  // given, or the rows under the pointer move: in Safari a press then
  // lands on another row and adds nothing.
  const before = await list.evaluate((element) => element.scrollHeight);
  await list.evaluate(async (element) => {
    for (let top = 0; top <= element.scrollHeight; top += 120) {
      element.scrollTop = top;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }
  });
  expect(await list.evaluate((element) => element.scrollHeight)).toBe(before);
});

function draftSaved(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().endsWith('/draft') &&
      response.ok(),
  );
}

test('inserts a step into an existing link and restores the link with one undo', async ({
  context,
  page,
}) => {
  const remote = remoteDraft(mappingGraph());
  const before = workflowGraphSchema.parse(remote.graph);
  const [original] = before.edges;
  if (original === undefined) throw new Error('Expected a connected workflow');
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);

  await page.getByTestId(`rf__edge-${original.id}`).press('Enter');
  await page
    .getByRole('button', { name: /Insert step into link/ })
    .press('Enter');
  const picker = page.getByRole('dialog', {
    name: 'Insert a step into this link',
  });
  await expect(
    picker.getByRole('searchbox', { name: 'Search steps' }),
  ).toBeFocused();
  await expect(
    picker.getByRole('button', { name: /Manual start/u }),
  ).toHaveCount(0);
  const addedSave = draftSaved(page);
  await picker.getByRole('button', { name: /Set fields/u }).click();

  await addedSave;
  expect(remote.graph.edges).toHaveLength(2);
  const added = workflowGraphSchema
    .parse(remote.graph)
    .nodes.find((node) => !before.nodes.some(({ id }) => id === node.id));
  expect(added).toBeDefined();
  expect(remote.graph.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: original.source,
        target: { nodeId: added?.id, port: 'in' },
      }),
      expect.objectContaining({
        source: { nodeId: added?.id, port: 'out' },
        target: original.target,
      }),
    ]),
  );

  await openWorkflowMenu(page);
  const undoSave = draftSaved(page);
  await page.getByRole('menuitem', { name: 'Undo' }).click();
  await undoSave;
  expect(remote.graph.edges).toEqual([original]);
  expect(remote.graph.nodes).toHaveLength(2);
});
