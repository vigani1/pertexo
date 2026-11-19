import { expect, test } from '../support/fixtures';
import {
  clearSpoken,
  expectFocusOn,
  expectSpoken,
  startScreenReader,
} from '../support/screen-reader';
import { focusStep } from '../workflow-editor/actions';
import { mappingGraph } from '../workflow-editor/graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
} from '../workflow-editor/support';

test('a screen-reader user hears each step by name and each save while adding a step by keyboard', async ({
  context,
  page,
}) => {
  const remote = remoteDraft({ ...mappingGraph(), edges: [] });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  await expect(
    page.getByRole('region', { name: 'Workflow canvas' }),
  ).toBeVisible();
  await startScreenReader(page);

  // Arriving on a step names it, not just "node".
  await focusStep(page, 'target');
  await expectSpoken(page, /^node, Target, Set fields,/u);

  // Add a step after it from the step's menu.
  await page.keyboard.press('Enter');
  const menu = page.getByRole('button', { name: 'Step actions' });
  await menu.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Add step after' }).focus();
  await page.keyboard.press('Enter');
  const lens = page.getByRole('dialog', { name: 'Add a step after “Target”' });
  await expectFocusOn(page, 'searchbox', 'Search steps');
  await page.keyboard.type('set');
  await lens.getByRole('button', { name: /Set fields/u }).focus();
  await clearSpoken(page);
  await page.keyboard.press('Enter');
  await expect(lens).toBeHidden();
  // The save is heard as it happens.
  await expectSpoken(page, /^polite: Saving…$/u);
  await expectSpoken(page, /^polite: Saved/u);
  expect(remote.graph.nodes).toHaveLength(3);
  expect(remote.graph.edges).toEqual([
    expect.objectContaining({ source: { nodeId: 'target', port: 'out' } }),
  ]);
});

test('a screen-reader user links two steps from the step panel and lands back on Link a step', async ({
  context,
  page,
}) => {
  const remote = remoteDraft({ ...mappingGraph(), edges: [] });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  await expect(
    page.getByRole('region', { name: 'Workflow canvas' }),
  ).toBeVisible();
  await startScreenReader(page);

  await focusStep(page, 'target');
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Inputs', exact: true }).focus();
  await page.keyboard.press('Enter');
  const links = page.getByRole('region', { name: 'Linked from', exact: true });
  await links.getByRole('button', { name: 'Link a step', exact: true }).focus();
  await page.keyboard.press('Enter');
  for (const [label, choice] of [
    ['Link from step', 'Manual input'],
    ['From output', 'out'],
    ['Into input', 'in'],
  ] as const) {
    await links.getByLabel(label, { exact: true }).focus();
    await page.keyboard.press('Enter');
    // Typing a name moves to its option, as in any native list.
    await page.keyboard.type(choice);
    await expectFocusOn(page, 'option', choice);
    await page.keyboard.press('Enter');
  }
  await clearSpoken(page);
  await links.getByRole('button', { name: 'Link', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expectSpoken(page, /^polite: Saved/u);
  expect(remote.graph.edges).toEqual([
    expect.objectContaining({
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: 'target', port: 'in' },
    }),
  ]);
  // The form closes and focus returns to the button that opened it, below
  // the new link.
  await expectFocusOn(page, 'button', 'Link a step');
  await expect(
    links.getByRole('button', { name: 'Remove link from Manual input' }),
  ).toBeVisible();
  // The new link is on the canvas under its steps' names.
  await expect(
    page.getByLabel('Link from Manual input to Target', { exact: true }),
  ).toHaveCount(1);
});
