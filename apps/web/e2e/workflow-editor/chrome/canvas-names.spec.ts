import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { expect, test } from '../../support/fixtures';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from '../support';

test('names canvas links by their steps in the accessibility tree', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  const definitions = nodeDefinitionListResponseSchema.parse({
    items: platformBrowserNodeDefinitionCatalog().definitions,
  }).items;
  await installEditorRoutes(page, remoteDraft(mappingGraph()), {
    definitions,
  });
  await page.goto(editorUrl);
  const link = page.getByTestId('rf__edge-manual-target');
  await expect(link).toHaveAccessibleName('Link from Manual input to Target');
  // No step ID reaches a screen reader through the canvas.
  const tree = await page
    .getByRole('region', { name: 'Workflow canvas' })
    .ariaSnapshot();
  expect(tree).toContain('Link from Manual input to Target');
  expect(tree).not.toMatch(/Edge from|manual-target|\bmanual\b to/u);
});
