import { workflowGraphSchema } from '@pertexo/workflow-model';
import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  definition,
  manualDefinition,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  mappingGraph,
  workspace,
} from './support';

test.beforeEach(async ({ context }) => {
  await addCsrfCookie(context);
});

for (const theme of ['light', 'dark'] as const)
  for (const width of [1440, 990, 375]) {
    test(`edits and preserves canvas documentation with keyboard controls at ${String(width)}px in ${theme}`, async ({
      page,
    }) => {
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await page.setViewportSize({ width, height: 768 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const remote = remoteDraft(mappingGraph());
      await installEditorRoutes(page, remote, {
        definitions: [manualDefinition, definition],
      });
      await page.goto(editorUrl);
      const toolbar = page.getByRole('toolbar', {
        name: 'Canvas tools',
        exact: true,
      });
      await expect(
        toolbar.getByRole('button', { name: 'Add note', exact: true }),
      ).toHaveText('Add note');
      await toolbar
        .getByRole('button', { name: 'Add note', exact: true })
        .click();
      const form = page.getByRole('dialog', { name: 'Edit note' });
      await expect(
        form.getByRole('textbox', { name: 'Note', exact: true }),
      ).toBeFocused();
      await form
        .getByRole('textbox', { name: 'Note', exact: true })
        .fill('# Orders\n\nKeep **one** per order.\n\n- Capture\n- Validate');
      await form
        .getByRole('button', { name: 'Save note', exact: true })
        .click();
      const note = page.getByRole('article', {
        name: 'Canvas note',
        exact: true,
      });
      await expect(note).toBeVisible();
      await expect(
        note.getByRole('heading', { name: 'Orders', exact: true }),
      ).toBeVisible();
      await expect(note.locator('strong')).toHaveText('one');
      await expect(note).toBeFocused();
      await expect.poll(() => remote.graph.notes?.length).toBe(1);
      const original = remote.graph.notes?.[0];
      if (original === undefined) throw new Error('Saved note missing');
      await page.keyboard.press('ArrowRight');
      await expect
        .poll(() => remote.graph.notes?.[0]?.position.x)
        .toBe(original.position.x + 10);
      await page.keyboard.press('Shift+ArrowDown');
      await expect
        .poll(() => remote.graph.notes?.[0]?.size.height)
        .toBe(original.size.height + 10);
      if (width === 375) {
        await page
          .getByRole('button', { name: 'Canvas notes', exact: true })
          .click();
        await page.getByRole('menuitem', { name: /Orders/u }).click();
      } else
        await note
          .getByRole('button', { name: 'Edit note', exact: true })
          .click();
      await page
        .getByRole('dialog')
        .getByRole('combobox', { name: 'Colour' })
        .click();
      await page.getByRole('option', { name: 'Amber', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('spinbutton', { name: 'Width', exact: true })
        .fill('420');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Save note', exact: true })
        .click();
      await expect.poll(() => remote.graph.notes?.[0]?.size.width).toBe(420);
      await page.reload();
      await expect(
        note.getByRole('heading', { name: 'Orders', exact: true }),
      ).toBeVisible();
      await note.focus();
      await page.keyboard.press('Delete');
      await expect(note).toHaveCount(0);
      if (width < 1024) {
        const bar = await page
          .getByRole('navigation', { name: 'Editor panels' })
          .boundingBox();
        const toast = await page
          .locator('[data-slot="toast-viewport"]')
          .boundingBox();
        expect(bar).not.toBeNull();
        expect(toast).not.toBeNull();
        if (bar !== null && toast !== null)
          expect(toast.y + toast.height).toBeLessThan(bar.y);
      }
      await page
        .getByRole('button', { name: 'Undo', exact: true })
        .last()
        .click();
      await expect(note).toBeVisible();
      await expect.poll(() => remote.graph.notes?.length).toBe(1);
      expect(remote.graph.nodes).toEqual(mappingGraph().nodes);
      expect(remote.graph.edges).toEqual(mappingGraph().edges);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`notes-${theme}-${String(width)}.png`),
        fullPage: true,
      });
    });
  }

test('keeps imported Markdown inert and documentation read-only for viewers', async ({
  page,
}) => {
  const graph = {
    ...mappingGraph(),
    notes: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        text: '# Safe note\n\n<script>window.noteExecuted=true</script>\n\n![Image](https://example.test/image.png)\n\n[Bad](javascript:alert(1)) [Good](https://example.test/docs)',
        position: { x: 80, y: 250 },
        size: { width: 360, height: 240 },
        color: 'violet' as const,
      },
    ],
  };
  const remote = remoteDraft(graph);
  let embedded = 0;
  await page.route('https://example.test/**', (route) => {
    embedded++;
    return route.abort();
  });
  await installEditorRoutes(page, remote, {
    accessibleWorkspace: {
      ...workspace,
      role: 'viewer',
      capabilities: ['workspace:read', 'workflow:read', 'run:read'],
    },
  });
  await page.goto(editorUrl);
  const note = page.getByRole('article', { name: 'Canvas note', exact: true });
  await expect(
    note.getByRole('heading', { name: 'Safe note', exact: true }),
  ).toBeVisible();
  await expect(
    note.locator('script,img,iframe,a[href^="javascript:"]'),
  ).toHaveCount(0);
  await expect(
    note.getByRole('link', { name: 'Good', exact: true }),
  ).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(
    page.getByRole('button', { name: 'Add note', exact: true }),
  ).toHaveCount(0);
  await expect(
    note.getByRole('button', { name: 'Edit note', exact: true }),
  ).toHaveCount(0);
  await note.focus();
  await page.keyboard.press('Delete');
  await expect(note).toBeVisible();
  expect(embedded).toBe(0);
  expect(await page.evaluate(() => 'noteExecuted' in window)).toBe(false);
});

test('commits one undoable change for each pointer drag and resize', async ({
  page,
}) => {
  const initial = {
    id: '00000000-0000-4000-8000-000000000002',
    text: '# Gesture notes',
    position: { x: 100, y: 270 },
    size: { width: 320, height: 200 },
    color: 'sage' as const,
  };
  const remote = remoteDraft({ ...mappingGraph(), notes: [initial] });
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(editorUrl);
  const note = page.getByRole('article', { name: 'Canvas note', exact: true });
  const header = note.locator('header');
  const bounds = await header.boundingBox();
  if (bounds === null) throw new Error('Note header missing');
  await page.mouse.move(bounds.x + 45, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 125, bounds.y + bounds.height / 2 + 40, {
    steps: 6,
  });
  await page.mouse.up();
  await expect
    .poll(() => remote.graph.notes?.[0]?.position)
    .not.toEqual(initial.position);
  await note.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(() => remote.graph.notes?.[0]?.position)
    .toEqual(initial.position);
  await note.hover();
  const corner = page.locator(
    '.react-flow__node-note .react-flow__resize-control.handle.bottom.right',
  );
  const handle = await corner.boundingBox();
  if (handle === null) throw new Error('Resize handle missing');
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 60,
    handle.y + handle.height / 2 + 35,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect
    .poll(() => remote.graph.notes?.[0]?.size.width)
    .toBeGreaterThan(initial.size.width);
  await note.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => remote.graph.notes?.[0]?.size).toEqual(initial.size);
  expect(remote.graph.nodes).toEqual(mappingGraph().nodes);
});

test('compares and reapplies a note-only conflict without replacing steps', async ({
  page,
}) => {
  const initial = {
    id: '00000000-0000-4000-8000-000000000003',
    text: 'Original note',
    position: { x: 80, y: 270 },
    size: { width: 320, height: 200 },
    color: 'amber' as const,
  };
  const remote = remoteDraft({ ...mappingGraph(), notes: [initial] });
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  await page.getByRole('article', { name: 'Canvas note' }).focus();
  await page.keyboard.press('Enter');
  const form = page.getByRole('dialog', { name: 'Edit note' });
  await form
    .getByRole('textbox', { name: 'Note', exact: true })
    .fill('My documented change');
  remote.graph = {
    ...remote.graph,
    notes: [{ ...initial, text: 'Their documented change' }],
  };
  remote.revision++;
  await form.getByRole('button', { name: 'Save note' }).click();
  const conflict = page.getByRole('region', { name: 'Draft conflict' });
  await expect(conflict).toContainText('Changed elsewhere');
  await conflict.getByRole('button', { name: 'Compare' }).click();
  await page.getByRole('tab', { name: 'Steps and notes', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Note: My documented change',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await conflict
    .getByRole('button', { name: 'Keep mine', exact: true })
    .click();
  await conflict.getByRole('button', { name: 'Compare' }).click();
  await page
    .getByRole('button', {
      name: 'Use your copy of Note: My documented change',
      exact: true,
    })
    .click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect
    .poll(() => remote.graph.notes?.[0]?.text)
    .toBe('My documented change');
  expect(remote.graph.nodes).toEqual(mappingGraph().nodes);
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
    expect(touchBounds?.width).toBeGreaterThanOrEqual(40);
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
