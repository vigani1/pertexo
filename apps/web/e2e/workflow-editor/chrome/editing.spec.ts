import type { Locator } from '@playwright/test';

import { expect, test } from '../../support/fixtures';

import { addStep, blocksUnload } from '../actions';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspaceId,
} from '../support';

test('edits typed input mappings live, saves them and restores rendered controls after reload', async ({
  context,
  page,
}) => {
  const remote = remoteDraft(mappingGraph());
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  await expect(
    page.getByRole('heading', { name: 'Customer onboarding' }),
  ).toBeVisible();
  await page.getByTestId('rf__node-target').click();
  await page.getByRole('tab', { name: 'Inputs' }).click();
  const inputs = page.getByRole('region', { name: 'Inputs' });
  const rows = inputs.getByRole('listitem');

  await inputs.getByRole('button', { name: 'Add input' }).click();
  await rows.nth(0).getByLabel('Field', { exact: true }).fill('customer');
  await rows.nth(0).getByRole('button', { name: 'Step output' }).click();
  await rows
    .nth(0)
    .getByLabel('Output path', { exact: true })
    .fill('$.customer');

  await inputs.getByRole('button', { name: 'Add input' }).click();
  await rows.nth(1).getByLabel('Field', { exact: true }).fill('requestedBy');
  await rows.nth(1).getByRole('button', { name: 'Run input' }).click();
  await rows
    .nth(1)
    .getByLabel('Run input path', { exact: true })
    .fill('$.actor.name');

  await inputs.getByRole('button', { name: 'Add input' }).click();
  await rows.nth(2).getByLabel('Field', { exact: true }).fill('payload');
  await rows
    .nth(2)
    .getByLabel('JSON value', { exact: true })
    .fill('{"__proto__":{"x":1},"normal":2,"nested":[{"__proto__":3}]}');
  await expect
    .poll(() => JSON.stringify(remote.graph), { timeout: 6_000 })
    .toContain(
      '"payload":{"kind":"literal","value":{"__proto__":{"x":1},"normal":2,"nested":[{"__proto__":3}]}}',
    );
  await expect(page.getByText(/^Saved/u)).toBeVisible();
  expect(remote.graph.nodes[1]).toMatchObject({
    inputMappings: {
      customer: { kind: 'node_output', nodeId: 'manual', path: '$.customer' },
      requestedBy: { kind: 'run_input', path: '$.actor.name' },
      payload: { kind: 'literal' },
    },
  });

  await page.reload();
  await page.getByTestId('rf__node-target').click();
  await page.getByRole('tab', { name: 'Inputs' }).click();
  const restored = page.getByRole('region', { name: 'Inputs' });
  const restoredRows = restored.getByRole('listitem');
  await expect(restoredRows).toHaveCount(3);
  // Saved inputs read as compact `field ← source` rows until opened.
  const customerRow = restoredRows.nth(0).getByRole('button', {
    name: 'customer from Manual input › customer',
  });
  await expect(customerRow).toHaveAttribute('aria-expanded', 'false');
  await customerRow.click();
  await expect(
    restoredRows.nth(0).getByLabel('Field', { exact: true }),
  ).toHaveValue('customer');
  await expect(
    restoredRows.nth(0).getByLabel('Output path', { exact: true }),
  ).toHaveValue('$.customer');
  await restoredRows
    .nth(2)
    .getByRole('button', { name: /^payload from \{3 fields\}/u })
    .click();
  const restoredLiteral = await restoredRows
    .nth(2)
    .getByLabel('JSON value', { exact: true })
    .inputValue();
  expect(JSON.parse(restoredLiteral)).toEqual(
    JSON.parse('{"__proto__":{"x":1},"normal":2,"nested":[{"__proto__":3}]}'),
  );
});

test('edits, autosaves, and preserves both drafts during a two-tab conflict', async ({
  context,
  page,
}) => {
  const remote = remoteDraft();
  await addCsrfCookie(context);
  const second = await context.newPage();
  await installEditorRoutes(page, remote);
  await installEditorRoutes(second, remote);
  await Promise.all([page.goto(editorUrl), second.goto(editorUrl)]);
  await addStep(page, /Set fields/u).click();
  await expect(page.getByText('Unsaved')).toBeVisible();
  await expect
    .poll(() => remote.graph.nodes.length, { timeout: 4_000 })
    .toBe(1);
  await expect(page.getByText(/^Saved/u)).toBeVisible();
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);

  await addStep(second, /Set fields/u).click();
  const conflict = second.getByRole('region', { name: 'Draft conflict' });
  await expect(conflict).toContainText('Changed elsewhere (revision 2)', {
    timeout: 4_000,
  });
  await conflict.getByRole('button', { name: 'Compare' }).click();
  await second.getByRole('tab', { name: 'JSON' }).click();
  await expect(second.getByText(/1 step, 0 links/u)).toHaveCount(2);
  await second.getByRole('button', { name: 'Close' }).click();
  await conflict.getByRole('button', { name: 'Keep mine' }).click();
  await expect(conflict).toBeHidden();
  // My one step replaces theirs, saved from their revision.
  await expect.poll(() => remote.revision).toBe(3);
  expect(remote.graph.nodes).toHaveLength(1);
  await expect(second.getByText(/^Saved/u)).toBeVisible();
  await expect(second.locator('.react-flow__node')).toHaveCount(1);
  expect(await blocksUnload(second)).toBe(false);
  await second.getByRole('link', { name: 'Back to workflows' }).click();
  await expect(second).toHaveURL(`/w/${workspaceId}/workflows`);
});

test('keeps keyboard placement usable and the narrow editor horizontally bounded', async ({
  context,
  page,
}) => {
  const remote = remoteDraft();
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(editorUrl);
  const panels = page.getByRole('navigation', { name: 'Editor panels' });
  await expect(panels).toBeVisible();
  const canvas = page.getByRole('region', { name: 'Workflow canvas' });
  await expect(canvas).toBeVisible();
  await panels.getByRole('button', { name: 'Add step' }).focus();
  await page.keyboard.press('Enter');
  const add = addStep(page, /Set fields/u);
  await expect(add).toBeVisible();
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Unsaved')).toBeVisible();
  await expect(page.getByText(/^Saved/u)).toBeVisible({ timeout: 4_000 });
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox?.width).toBeGreaterThan(360);
  expect(canvasBox?.height).toBeGreaterThan(500);
  await page.locator('.react-flow__node').click();
  await panels.getByRole('button', { name: 'Step', exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Mobile scratch');
  await panels.getByRole('button', { name: 'Canvas' }).click();
  await panels.getByRole('button', { name: 'Step', exact: true }).click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
    'Mobile scratch',
  );
  // A tap outside the panel puts it away, like any sheet, and keeps its edit.
  const stepPanel = page.getByRole('complementary', { name: 'Step panel' });
  const outside = await page.evaluate(() => {
    for (let y = 0; y < innerHeight; y += 8)
      for (let x = 0; x < innerWidth; x += 8)
        if (
          document.elementFromPoint(x, y)?.getAttribute('data-slot') ===
          'panel-dismiss'
        )
          return { x, y };
    return null;
  });
  expect(outside).not.toBeNull();
  await page.mouse.click(outside?.x ?? 0, outside?.y ?? 0);
  await expect(stepPanel).toBeHidden();
  // A double tap on the step brings its panel back, its edit still there.
  await page.locator('.react-flow__node').dblclick();
  await expect(stepPanel).toBeVisible();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
    'Mobile scratch',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('shows keyboard focus on step cards, links and step panel tabs', async ({
  context,
  page,
}) => {
  const remote = remoteDraft(mappingGraph());
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  await expect(
    page.getByRole('heading', { name: 'Customer onboarding' }),
  ).toBeVisible();
  // Arrive by keyboard so :focus-visible applies.
  const arrive = async (target: Locator) => {
    await target.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(target).toBeFocused();
  };
  const outline = (target: Locator) =>
    target.evaluate((element) => getComputedStyle(element).outlineStyle);

  const step = page.getByTestId('rf__node-target');
  await arrive(step);
  expect(await outline(step.locator('article'))).not.toBe('none');
  // Escape lets go of the step but keeps focus on the canvas.
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('region', { name: 'Workflow canvas' }),
  ).toBeFocused();

  const link = page.getByTestId('rf__edge-manual-target');
  const thread = link.locator('.react-flow__edge-path');
  const stroke = () =>
    thread.evaluate((element) => getComputedStyle(element).stroke);
  const resting = await stroke();
  await arrive(link);
  // The thread eases into its new colour.
  await expect.poll(stroke).not.toBe(resting);

  await step.click();
  const inputsTab = page.getByRole('tab', { name: 'Inputs' });
  await arrive(inputsTab);
  expect(await outline(inputsTab)).not.toBe('none');
});

test('keeps workflow identity bounded at 320 and 390 pixels once metadata loads', async ({
  context,
  page,
}) => {
  const remote = remoteDraft();
  let metadataAvailable = false;
  const longName = 'W'.repeat(128);
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) =>
      metadataAvailable
        ? route.fulfill({ json: workflowSummary(longName) })
        : route.fulfill({ status: 500, json: {} }),
  );

  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(editorUrl);
  await expect(page.getByRole('heading', { name: 'Workflow' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Workflow canvas' }),
  ).toBeVisible();

  metadataAvailable = true;
  await page.reload();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const identity = page.getByRole('heading', { name: longName });
    await expect(identity).toBeVisible();
    const box = await identity.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    const canvasBox = await page
      .getByRole('region', { name: 'Workflow canvas' })
      .boundingBox();
    expect(canvasBox?.width).toBeGreaterThan(width - 30);
    expect(canvasBox?.height).toBeGreaterThan(400);
  }
});
