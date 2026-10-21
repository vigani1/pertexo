import { expect, test } from '../../support/fixtures';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from '../support';
const definitions = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions,
}).items;
for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 990, 1440])
    test(`authors saved business values in ${theme} at ${String(width)}px`, async ({
      page,
      context,
    }, info) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await addCsrfCookie(context);
      const remote = remoteDraft({
        nodes: [
          {
            id: 'save',
            label: 'Find this order',
            definition: { key: 'core.run_values', version: 1 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            position: { x: 80, y: 80 },
          },
        ],
        edges: [],
        settings: {},
      });
      await installEditorRoutes(page, remote, { definitions });
      await page.goto(editorUrl);
      await page.getByTestId('rf__node-save').click();
      if (width < 1024)
        await page
          .getByRole('navigation', { name: 'Editor panels' })
          .getByRole('button', { name: 'Step', exact: true })
          .click();
      await page.getByRole('tab', { name: 'Setup', exact: true }).click();
      await page.getByRole('button', { name: 'Add run value' }).click();
      await page.getByLabel('Key', { exact: true }).fill('orderId');
      await page.getByLabel('Value', { exact: true }).fill('A-1042');
      await expect
        .poll(
          () => parseWorkflowGraphDraft(remote.graph).nodes[0]?.inputMappings,
        )
        .toEqual({ values: { kind: 'literal', value: { orderId: 'A-1042' } } });
      await page.reload();
      await page.getByTestId('rf__node-save').click();
      if (width < 1024)
        await page
          .getByRole('navigation', { name: 'Editor panels' })
          .getByRole('button', { name: 'Step', exact: true })
          .click();
      await page.getByRole('tab', { name: 'Setup', exact: true }).click();
      await expect(page.getByLabel('Key', { exact: true })).toHaveValue(
        'orderId',
      );
      await expect(page.getByLabel('Value', { exact: true })).toHaveValue(
        'A-1042',
      );
      await expect(
        page.getByText(/Use business data, never secrets/),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`run-values-${theme}-${String(width)}.png`),
        fullPage: true,
      });
    });
