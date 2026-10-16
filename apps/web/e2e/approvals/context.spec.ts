import { expect, test } from '../support/fixtures';
import {
  approvalConfigSchema,
  inputRequestConfigSchema,
} from '@pertexo/workflow-model';
import { platformBrowserNodeDefinitionCatalog } from '../../../../packages/node-catalog/dist/index.js';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from '../workflow-editor/support';

for (const width of [1280, 375])
  for (const key of ['core.approval', 'core.request_input'])
    test(`edits task details and prefills with mapping controls: ${key} at ${String(width)}px`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 768 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const config =
        key === 'core.approval'
          ? approvalConfigSchema.parse({})
          : inputRequestConfigSchema.parse({
              fields: [
                { id: 'answer', name: 'answer', label: 'Answer', type: 'text' },
              ],
            });
      const remote = remoteDraft({
        nodes: [
          {
            id: 'review',
            definition: { key, version: 1 },
            configVersion: 1,
            config,
            inputMappings: {},
            connectionRefs: {},
            position: { x: 80, y: 80 },
          },
        ],
        edges: [],
        settings: {},
      });
      await installEditorRoutes(page, remote, {
        definitions: platformBrowserNodeDefinitionCatalog().definitions,
      });
      await addCsrfCookie(context);
      async function open() {
        await page.goto(editorUrl);
        await page.getByTestId('rf__node-review').click();
        if (width < 1024)
          await page
            .getByRole('navigation', { name: 'Editor panels' })
            .getByRole('button', { name: 'Step', exact: true })
            .click();
      }
      await open();
      await page
        .getByRole('button', { name: 'Add detail', exact: true })
        .click();
      const detail = page.getByRole('region', { name: 'Detail', exact: true });
      await detail.getByLabel('Label', { exact: true }).fill('Customer');
      await detail.getByLabel('Value', { exact: true }).fill('Ada');
      await expect
        .poll(() => remote.graph.nodes)
        .toMatchObject([
          {
            inputMappings: {
              details: { kind: 'literal', value: { Customer: 'Ada' } },
            },
          },
        ]);
      await detail
        .getByRole('button', { name: 'Run input', exact: true })
        .click();
      await detail
        .getByLabel('Run input path', { exact: true })
        .fill('$.customer');
      await expect
        .poll(() => remote.graph.nodes)
        .toMatchObject([
          {
            inputMappings: {
              details: {
                kind: 'expression',
                expression: expect.stringContaining('runInput."customer"'),
              },
            },
          },
        ]);
      await open();
      await expect(
        detail.getByLabel('Run input path', { exact: true }),
      ).toHaveValue('$.customer');
      await detail
        .getByRole('button', { name: 'Expression', exact: true })
        .click();
      await detail
        .getByLabel('Expression', { exact: true })
        .fill('runInput.customer');
      await expect
        .poll(() => remote.graph.nodes)
        .toMatchObject([
          {
            inputMappings: {
              details: {
                kind: 'expression',
                expression: expect.stringContaining('(runInput.customer)'),
              },
            },
          },
        ]);
      if (key === 'core.request_input') {
        await page
          .getByRole('button', { name: 'Add prefill', exact: true })
          .click();
        const prefill = page.getByRole('region', {
          name: 'Prefill Answer',
          exact: true,
        });
        await prefill
          .getByLabel('Value', { exact: true })
          .fill('Suggested answer');
        await expect
          .poll(() => remote.graph.nodes)
          .toMatchObject([
            {
              inputMappings: {
                prefill: {
                  kind: 'literal',
                  value: { answer: 'Suggested answer' },
                },
              },
            },
          ]);
      }
      await open();
      await expect(detail.getByLabel('Label', { exact: true })).toHaveValue(
        'Customer',
      );
      await expect(
        detail.getByLabel('Expression', { exact: true }),
      ).toHaveValue('runInput.customer');
      await detail
        .getByLabel('Expression', { exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `/tmp/pertexo-leftovers-${key}-${String(width)}.png`,
        fullPage: true,
      });
      await detail
        .getByRole('button', { name: 'Remove detail Customer', exact: true })
        .click();
      await expect
        .poll(() => remote.graph.nodes)
        .toMatchObject([
          { inputMappings: { details: { kind: 'literal', value: {} } } },
        ]);
      await expect(detail).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
