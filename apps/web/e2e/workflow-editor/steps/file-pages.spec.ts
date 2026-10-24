import { expect, test, type Page } from '../../support/fixtures';
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
async function choose(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 990, 1440])
    for (const kind of ['read_file', 'create_file', 'http'] as const) {
      test(`authors explicit ${kind} pages in ${theme} at ${String(width)}px`, async ({
        page,
        context,
      }, info) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.addInitScript((choice) => {
          localStorage.setItem('pertexo.appearance', choice);
        }, theme);
        await addCsrfCookie(context);
        const config =
          kind === 'http'
            ? {
                method: 'GET',
                url: 'https://api.example.test/data',
                headers: {},
                timeoutMillis: 1000,
                maxRedirects: 0,
                maxResponseBytes: 1048576,
                inlineResponseBytes: 65536,
                pagination: {
                  mode: 'page',
                  parameter: 'page',
                  itemsPath: '$.data',
                  maxPages: 10,
                  delayMillis: 0,
                },
              }
            : {
                format: 'csv',
                delimiter: ',',
                ...(kind === 'create_file'
                  ? { columns: ['id'] }
                  : { convertValues: true }),
              };
        const remote = remoteDraft({
          nodes: [
            {
              id: 'file',
              label: 'File data',
              definition: {
                key: kind === 'http' ? 'http.request' : `core.${kind}`,
                version: 1,
              },
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
        await installEditorRoutes(page, remote, { definitions });
        const saved = () => parseWorkflowGraphDraft(remote.graph).nodes[0];
        async function setup() {
          await page.getByTestId('rf__node-file').click();
          if (width < 1024)
            await page
              .getByRole('navigation', { name: 'Editor panels' })
              .getByRole('button', { name: 'Step', exact: true })
              .click();
          await page.getByRole('tab', { name: 'Setup', exact: true }).click();
        }
        await page.goto(editorUrl);
        await setup();
        if (kind === 'http') {
          await page
            .getByText('Pagination · Page number', { exact: true })
            .click();
          await choose(page, 'Results', 'Save items as pages');
          await expect
            .poll(() => saved()?.config.pagination)
            .toMatchObject({ outputMode: 'pages' });
          await expect(
            page.getByText(/fetchedPageCount counts API requests/),
          ).toBeVisible();
        } else {
          await choose(
            page,
            kind === 'read_file' ? 'Output' : 'Data source',
            kind === 'read_file' ? 'Output pages' : 'From pages',
          );
          await expect
            .poll(
              () =>
                saved()?.config[
                  kind === 'read_file' ? 'outputMode' : 'inputMode'
                ],
            )
            .toBe('pages');
          await choose(page, 'File format', 'JSON');
          await expect
            .poll(() => saved()?.config)
            .toMatchObject({
              format: 'json',
              [kind === 'read_file' ? 'outputMode' : 'inputMode']: 'pages',
            });
        }
        await page.reload();
        await setup();
        if (kind === 'http')
          await page
            .getByText('Pagination · Page number', { exact: true })
            .click();
        await expect(
          page.getByRole('combobox', {
            name: {
              read_file: 'Output',
              create_file: 'Data source',
              http: 'Results',
            }[kind],
            exact: true,
          }),
        ).toHaveText(
          {
            read_file: 'Output pages',
            create_file: 'From pages',
            http: 'Save items as pages',
          }[kind],
        );
        await page
          .getByRole('combobox', {
            name: {
              read_file: 'Output',
              create_file: 'Data source',
              http: 'Results',
            }[kind],
            exact: true,
          })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: info.outputPath(`pages-${kind}-${theme}-${String(width)}.png`),
          fullPage: true,
          animations: 'disabled',
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      });
    }
