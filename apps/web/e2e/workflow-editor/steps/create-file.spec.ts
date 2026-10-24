import { openStepSetup } from '../../../test/support/browser/steps';
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
    test(`authors Create file in ${theme} at ${String(width)}px`, async ({
      page,
      context,
    }, info) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await addCsrfCookie(context);
      const data = [{ currency: 'EUR', amount: 12.5, paid: true }];
      const remote = remoteDraft({
        nodes: [
          {
            id: 'create',
            label: 'Prepare export',
            definition: { key: 'core.create_file', version: 1 },
            configVersion: 1,
            config: { format: 'csv', delimiter: ',', columns: [] },
            inputMappings: { data: { kind: 'literal', value: data } },
            connectionRefs: {},
            position: { x: 80, y: 80 },
          },
        ],
        edges: [],
        settings: {},
      });
      const saved = () => parseWorkflowGraphDraft(remote.graph).nodes[0];
      await installEditorRoutes(page, remote, { definitions });
      await page.goto(editorUrl);
      await openStepSetup(page, { nodeId: 'create', width: width });
      const columns = page.getByRole('textbox', {
        name: 'Columns, in output order',
      });
      await columns.fill('paid\ncurrency\namount');
      await expect(columns).toBeFocused();
      await expect
        .poll(() => saved()?.config.columns)
        .toEqual(['paid', 'currency', 'amount']);
      await columns.fill('amount\namount');
      await columns.blur();
      await expect(
        page.getByText('Choose each column once.', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('combobox', { name: 'File format', exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'Edit as JSON', exact: true }),
      ).toBeDisabled();
      expect(saved()?.config.columns).toEqual(['paid', 'currency', 'amount']);
      await columns.fill('currency\namount');
      await columns.blur();
      await page
        .getByRole('combobox', { name: 'Delimiter', exact: true })
        .click();
      await page
        .getByRole('option', { name: 'Semicolon', exact: true })
        .click();
      await expect
        .poll(() => saved()?.config)
        .toEqual({
          format: 'csv',
          delimiter: ';',
          columns: ['currency', 'amount'],
        });
      await page.reload();
      await openStepSetup(page, { nodeId: 'create', width: width });
      await expect(columns).toHaveValue('currency\namount');
      await page.screenshot({
        path: info.outputPath(`create-file-${theme}-${String(width)}.png`),
        fullPage: true,
      });
      await page
        .getByRole('combobox', { name: 'File format', exact: true })
        .click();
      await page.getByRole('option', { name: 'JSON', exact: true }).click();
      await expect.poll(() => saved()?.config).toEqual({ format: 'json' });
      expect(saved()?.inputMappings).toEqual({
        data: { kind: 'literal', value: data },
      });
      await page.getByTestId('rf__node-create').focus();
      await page.keyboard.press('ControlOrMeta+z');
      await expect
        .poll(() => saved()?.config)
        .toEqual({
          format: 'csv',
          delimiter: ';',
          columns: ['currency', 'amount'],
        });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
