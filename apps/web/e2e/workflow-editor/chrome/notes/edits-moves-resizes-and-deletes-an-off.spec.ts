import { workflowGraphSchema } from '@pertexo/workflow-model';

import { expect, test } from '../../../support/fixtures';

import { mappingGraph } from '../../graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
} from '../../support';

test.beforeEach(async ({ context }) => {
  await addCsrfCookie(context);
});

test.describe('touch canvas documentation', () => {
  test.use({
    viewport: { width: 375, height: 768 },
    isMobile: true,
    hasTouch: true,
  });
  test('edits, moves, resizes and deletes an off-screen note using the toolbar', async ({
    page,
  }) => {
    const initial = {
      id: '00000000-0000-4000-8000-000000000004',
      text: 'Phone instructions',
      position: { x: 5000, y: 5000 },
      size: { width: 320, height: 200 },
      color: 'violet' as const,
    };
    const remote = remoteDraft({ ...mappingGraph(), notes: [initial] });
    await installEditorRoutes(page, remote, {
      definitions: [manualDefinition, definition],
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(editorUrl);
    const notes = page.getByRole('button', {
      name: 'Canvas notes',
      exact: true,
    });
    await notes.tap();
    await page
      .getByRole('menuitem', { name: 'Phone instructions', exact: true })
      .tap();
    const form = page.getByRole('dialog', { name: 'Edit note' });
    await form.getByText('Position and size', { exact: true }).tap();
    await form
      .getByRole('spinbutton', { name: 'Horizontal position', exact: true })
      .fill('160');
    await form
      .getByRole('spinbutton', { name: 'Vertical position', exact: true })
      .fill('300');
    await form
      .getByRole('spinbutton', { name: 'Width', exact: true })
      .fill('280');
    await form
      .getByRole('spinbutton', { name: 'Height', exact: true })
      .fill('160');
    await form
      .getByRole('textbox', { name: 'Note', exact: true })
      .fill('Updated phone instructions');
    await form.getByRole('button', { name: 'Save note', exact: true }).tap();
    await expect
      .poll(() => remote.graph.notes?.[0])
      .toMatchObject({
        text: 'Updated phone instructions',
        position: { x: 160, y: 300 },
        size: { width: 280, height: 160 },
      });
    await notes.tap();
    await page
      .getByRole('menuitem', {
        name: 'Updated phone instructions',
        exact: true,
      })
      .tap();
    await page.screenshot({
      path: test.info().outputPath('notes-touch-form.png'),
      fullPage: true,
    });
    await form.getByRole('button', { name: 'Delete note', exact: true }).tap();
    await expect.poll(() => remote.graph.notes?.length).toBe(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).last().tap();
    await expect.poll(() => remote.graph.notes?.length).toBe(1);
    const touchBounds = await page
      .getByRole('button', { name: 'Canvas notes', exact: true })
      .boundingBox();
    // Firefox may report 39.999992 for a 40 CSS px control.
    expect(
      Math.round((touchBounds?.width ?? 0) * 1000) / 1000,
    ).toBeGreaterThanOrEqual(40);
  });
});

test('keeps imported step IDs independent of documentation decorations', async ({
  page,
}) => {
  const id = '00000000-0000-4000-8000-000000000005';
  const stepId = `note:${id}`;
  const original = workflowGraphSchema.parse(mappingGraph());
  const remote = remoteDraft({
    ...original,
    settings: { ...original.settings },
    nodes: original.nodes.map((node) =>
      node.id === 'target' ? { ...node, id: stepId } : node,
    ),
    edges: [
      {
        id: 'manual-target',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: stepId, port: 'in' },
      },
    ],
    notes: [
      {
        id,
        text: 'Independent documentation',
        position: { x: 100, y: 270 },
        size: { width: 320, height: 200 },
        color: 'teal',
      },
    ],
  });
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  const step = page.getByTestId(`rf__node-${stepId}`);
  await step.click();
  await step.focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(
      () =>
        workflowGraphSchema
          .parse(remote.graph)
          .nodes.find((node) => node.id === stepId)?.position.x ?? 0,
    )
    .toBeGreaterThan(380);
  expect(remote.graph.notes?.[0]?.position).toEqual({ x: 100, y: 270 });
  const notes = page.getByRole('article', { name: 'Canvas note', exact: true });
  await expect(notes).toContainText('Independent documentation');
  await notes.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => remote.graph.notes?.[0]?.position.y).toBe(280);
  await page.keyboard.press('Delete');
  await expect.poll(() => remote.graph.notes?.length).toBe(0);
  expect(remote.graph.nodes).toHaveLength(2);
  await expect(step).toBeVisible();
});

test('keeps deeply nested imported Markdown readable and editable without breaking the canvas', async ({
  page,
}) => {
  const text = '>'.repeat(3998) + 'x';
  const remote = remoteDraft({
    ...mappingGraph(),
    notes: [
      {
        id: '00000000-0000-4000-8000-000000000006',
        text,
        position: { x: 100, y: 270 },
        size: { width: 420, height: 240 },
        color: 'neutral',
      },
    ],
  });
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  const note = page.getByRole('article', { name: 'Canvas note', exact: true });
  await expect(
    note.getByText(
      'This note has deeply nested formatting and is shown as plain text.',
    ),
  ).toBeVisible();
  await expect(note.locator('pre')).toHaveText(text);
  expect(remote.graph.notes?.[0]?.text).toBe(text);
  await note.getByRole('button', { name: 'Edit note', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Edit note' });
  await expect(
    form.getByRole('textbox', { name: 'Note', exact: true }),
  ).toHaveValue(text);
  await form
    .getByRole('textbox', { name: 'Note', exact: true })
    .fill('# Simplified instructions');
  await form.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(
    note.getByRole('heading', { name: 'Simplified instructions' }),
  ).toBeVisible();
  await expect
    .poll(() => remote.graph.notes?.[0]?.text)
    .toBe('# Simplified instructions');
  await expect(
    page.getByRole('button', { name: 'Add note', exact: true }),
  ).toBeVisible();
});
