import { expect, test } from '../../support/fixtures';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
  type Graph,
} from '../support';

/** Target sits far to the right, outside what a 320px canvas shows. */
function wideGraph(): Graph {
  const graph = mappingGraph();
  const [manual, target] = graph.nodes as [object, object];
  return {
    ...graph,
    nodes: [manual, { ...target, position: { x: 1400, y: 80 } }],
  };
}

// Bringing a step outside the view into sight (find in page, a screen
// reader, a click helper) used to scroll the canvas to it; React Flow
// scrolls the canvas back a frame later. Every step moved under the pointer
// and back, so a press that began on one step ended on another, the click
// was lost, and no step was selected. React Flow pans; the canvas never
// scrolls.
test('keeps the steps where they are when something scrolls a step into view', async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 768 });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remoteDraft(wideGraph()), {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  const start = page.getByTestId('rf__node-manual');
  const target = page.getByTestId('rf__node-target');
  await expect(start).toBeVisible();
  await expect(target).toBeAttached();

  const moved = await page.evaluate(() => {
    const step = document.querySelector<HTMLElement>(
      '[data-testid="rf__node-manual"]',
    );
    const away = document.querySelector<HTMLElement>(
      '[data-testid="rf__node-target"]',
    );
    if (step === null || away === null) throw new Error('Steps not drawn');
    const before = step.getBoundingClientRect();
    away.scrollIntoView();
    const after = step.getBoundingClientRect();
    return { x: after.x - before.x, y: after.y - before.y };
  });

  expect(moved).toEqual({ x: 0, y: 0 });
});
