import { expect, test } from '../../support/fixtures';

import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
  workspace,
} from '../support';

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
        .getByText('Position and size', { exact: true })
        .click();
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

test('compares every change category and reapplies a note without replacing steps', async ({
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
    edges: [],
    settings: { maxRunDurationMs: 60_000 },
    callable: {
      input: { type: 'string' },
      resultType: { type: 'string' },
      result: { kind: 'run_input', path: '$' },
    },
  };
  remote.revision++;
  await form.getByRole('button', { name: 'Save note' }).click();
  const conflict = page.getByRole('region', { name: 'Draft conflict' });
  await expect(conflict).toContainText('Changed elsewhere');
  await conflict.getByRole('button', { name: 'Compare' }).click();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Note: My documented change',
  );
  await expect(page.getByRole('dialog')).toContainText('Links between steps');
  await expect(page.getByRole('dialog')).toContainText(
    'Workflow execution settings',
  );
  await expect(page.getByRole('dialog')).toContainText(
    'Input or callable contract',
  );
  await page.screenshot({
    path: test.info().outputPath('complete-conflict-review.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await conflict
    .getByRole('button', { name: 'Keep mine', exact: true })
    .click();
  await conflict.getByRole('button', { name: 'Compare' }).click();
  await expect(
    page.getByRole('button', {
      name: /Use your copy of (Links|Workflow|Input)/u,
    }),
  ).toHaveCount(0);
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
