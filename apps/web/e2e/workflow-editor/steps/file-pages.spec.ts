import { fixtureStatistics } from '../../../test/support/fixtures/run';
import { expect, test, type Page } from '../../support/fixtures';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  workflowSummary,
  workflowId,
  currentEtag,
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
        await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
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
          await page.getByRole('button', { name: 'JSON', exact: true }).click();
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

for (const theme of ['light', 'dark'] as const)
  for (const viewport of [
    { width: 360, height: 740 },
    { width: 375, height: 768 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ])
    test(`saves an uploaded Read file mapping with a creation notification in ${theme} at ${String(viewport.width)}px`, async ({
      page,
      context,
    }, info) => {
      await page.setViewportSize({ width: 1280, height: 768 });
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await addCsrfCookie(context);
      const remote = remoteDraft({
        nodes: [
          {
            id: 'file',
            label: 'Read currency export',
            definition: { key: 'core.read_file', version: 1 },
            configVersion: 1,
            config: { format: 'csv', delimiter: ',', convertValues: true },
            inputMappings: {},
            connectionRefs: {},
            position: { x: 80, y: 80 },
          },
        ],
        edges: [],
        settings: {},
      });
      await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
      await installEditorRoutes(page, remote, {
        definitions,
        accessibleWorkspace: {
          ...workspace,
          capabilities: [...workspace.capabilities, 'workflow:create'],
        },
      });
      await page.route(
        `**/v1/workspaces/${workspaceId}/run-statistics?**`,
        (route) => route.fulfill({ json: fixtureStatistics() }),
      );
      await page.route(`**/v1/workspaces/${workspaceId}/workflows`, (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 201,
              headers: { etag: currentEtag(remote) },
              json: {
                ...workflowSummary('Read currency export'),
                draft: {
                  workflowId,
                  revision: remote.revision,
                  graph: remote.graph,
                  compatibility: {
                    compatible: true,
                    fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
                    issues: [],
                  },
                  updatedAt: '2026-09-14T10:00:00.000Z',
                },
              },
            })
          : route.fallback(),
      );
      const artifact = {
        id: '55555555-5555-4555-8555-555555555555',
        workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        byteLength: 72,
        mediaType: 'text/csv',
        sha256:
          '5159d0eb8a2c3146366f31450b1070ff3de5cbad072722ea10e4a87cd533062c',
        status: 'available',
        createdAt: new Date().toISOString(),
        expiresAt: null,
      };
      await page.route('**/artifacts/uploads', (route) =>
        route.fulfill({
          json: {
            artifact: {
              ...artifact,
              status: 'pending',
              expiresAt: new Date(Date.now() + 600000).toISOString(),
            },
            upload: {
              method: 'PUT',
              url: 'https://objects.example.test/mock-file-store',
              headers: {},
              expiresAt: new Date(Date.now() + 600000).toISOString(),
              expiresInSeconds: 600,
            },
            replayed: false,
          },
        }),
      );
      await page.route('**/mock-file-store', (route) =>
        route.fulfill({ status: 200 }),
      );
      await page.route('**/artifacts/*/finalize', (route) =>
        route.fulfill({ json: artifact }),
      );
      // The real creation toast outlives navigation and used to cover Use file.
      await page.goto(`/w/${workspaceId}/workflows`);
      await page
        .getByRole('button', { name: 'New workflow', exact: true })
        .click();
      await page
        .getByLabel('Workflow name', { exact: true })
        .fill('Read currency export');
      await page
        .getByRole('button', { name: 'Create workflow', exact: true })
        .click();
      await expect(page).toHaveURL(editorUrl);
      await expect(
        page.getByText('Workflow created', { exact: true }),
      ).toBeVisible();
      await page.getByTestId('rf__node-file').focus();
      await page.keyboard.press('Enter');
      await page
        .getByLabel('Label', { exact: true })
        .fill('Read currency export renamed');
      await page.keyboard.press('Tab');
      await page.setViewportSize(viewport);
      if (viewport.width < 1024)
        await page
          .getByRole('navigation', { name: 'Editor panels' })
          .getByRole('button', { name: 'Step', exact: true })
          .click();
      await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
      await page.getByRole('button', { name: 'Upload file to read' }).click();
      await page.getByLabel('File', { exact: true }).setInputFiles({
        name: 'export.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(
          'currency,amount,paid\nEUR,12.5,true\nEUR,7.5,true\nUSD,9,true\nEUR,100,false',
        ),
      });
      await expect(page.getByText('File ready', { exact: true })).toBeVisible();
      await page.screenshot({
        path: info.outputPath('upload-ready.png'),
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Use file', exact: true }).click();
      await expect
        .poll(
          () =>
            parseWorkflowGraphDraft(remote.graph).nodes[0]?.inputMappings.file,
        )
        .toMatchObject({
          kind: 'literal',
          value: { kind: 'artifact', artifactId: artifact.id },
        });
      await expect(
        page.getByRole('dialog', { name: 'Upload a file', exact: true }),
      ).toBeHidden();
    });
