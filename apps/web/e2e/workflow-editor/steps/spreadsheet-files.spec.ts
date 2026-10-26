import { openStepSetup } from '../../../test/support/browser/steps';
import { expect, test, type Page } from '../../support/fixtures';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../support';

const definitions = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions,
}).items;
const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`;
const workbook = {
  kind: 'artifact',
  artifactId: '44444444-4444-4444-8444-444444444444',
  byteLength: 8_412,
  mediaType:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  sha256: 'a'.repeat(64),
};
const disclosure = {
  sideEffectClass: 'safe',
  mayContactProvider: false,
  mayCauseExternalSideEffect: false,
  dryRun: 'not_supported',
};

async function prepare(page: Page, theme: 'light' | 'dark', width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((choice) => {
    localStorage.setItem('pertexo.appearance', choice);
  }, theme);
}

/** Answers step tests in turn: a missing sheet first, then its rows. */
async function answerTests(page: Page, revision: () => number) {
  let tests = 0;
  await page.route(`${root}/nodes/read/test`, async (route) => {
    const body = route.request().postDataJSON() as { mode: string };
    if (body.mode === 'validate') {
      await route.fulfill({
        json: {
          mode: 'validate',
          valid: true,
          revision: revision(),
          nodeId: 'read',
          issues: [],
          disclosure,
        },
      });
      return;
    }
    tests++;
    const failed = tests === 1;
    await route.fulfill({
      status: 202,
      json: {
        mode: 'test_execute',
        replayed: false,
        preview: {
          id: `55555555-5555-4555-8555-55555555555${String(tests)}`,
          workspaceId,
          workflowId,
          draftRevision: revision(),
          nodeId: 'read',
          status: failed ? 'failed' : 'succeeded',
          disclosure,
          output: failed
            ? null
            : {
                kind: 'inline',
                value: [
                  { region: 'North', city: 'Oslo', sales: 1240.5, paid: true },
                  { region: 'North', city: 'Bergen', sales: 980, paid: false },
                  { region: 'West', city: 'Stavanger', sales: 455, paid: true },
                  { region: 'West', city: 'Haugesund', sales: 120, paid: true },
                  { region: 'East', city: 'Hamar', sales: 75, paid: false },
                ],
              },
          safeErrorCode: failed ? 'execution.file_input' : null,
          ...(failed
            ? {
                errorSummary:
                  'The workbook has no sheet with that name. Its sheets: "Q1 2026", "Q2 2026", "Notes". Enter a name exactly, or leave Sheet empty to read the first visible sheet.',
              }
            : {}),
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 604_800_000).toISOString(),
        },
      },
    });
  });
}

async function runTest(page: Page, label: string) {
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  const acknowledge = page.getByRole('switch', {
    name: 'I understand this test runs for real',
  });
  if (!(await acknowledge.isChecked())) await acknowledge.click();
  await page.getByRole('button', { name: label, exact: true }).click();
}

for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 990, 1440])
    test(`reads an Excel sheet named by its last test in ${theme} at ${String(width)}px`, async ({
      page,
      context,
    }, info) => {
      await prepare(page, theme, width);
      await addCsrfCookie(context);
      const remote = remoteDraft({
        nodes: [
          {
            id: 'read',
            label: 'Read sales workbook',
            definition: { key: 'core.read_file', version: 1 },
            configVersion: 1,
            config: { format: 'csv', delimiter: ',', convertValues: true },
            inputMappings: { file: { kind: 'literal', value: workbook } },
            connectionRefs: {},
            position: { x: 80, y: 80 },
          },
        ],
        edges: [],
        settings: {},
      });
      const saved = () => parseWorkflowGraphDraft(remote.graph).nodes[0];
      await installEditorRoutes(page, remote, { definitions });
      await answerTests(page, () => remote.revision);
      await page.goto(editorUrl);
      await openStepSetup(page, { nodeId: 'read', width });
      const excel = page.getByRole('button', { name: 'Excel', exact: true });
      await excel.click();
      await expect(excel).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(() => saved()?.config)
        .toEqual({ format: 'xlsx', headerRow: 1, convertValues: true });
      await expect(
        page.getByText(/Test the step to see its first rows/u),
      ).toBeVisible();
      const grid = page.getByRole('figure');
      const before = await grid.boundingBox();
      await page.screenshot({
        path: info.outputPath(`read-placeholder-${theme}-${String(width)}.png`),
        fullPage: true,
      });
      const sheet = page.getByRole('textbox', { name: 'Sheet', exact: true });
      await sheet.fill('Sales');
      await expect.poll(() => saved()?.config.sheet).toBe('Sales');

      await runTest(page, 'Run test');
      await expect(
        page.getByRole('region', { name: 'Test result' }),
      ).toBeVisible();
      await page.getByRole('tab', { name: 'Setup', exact: true }).click();
      const suggestion = page.getByRole('button', {
        name: 'Use sheet Q2 2026',
        exact: true,
      });
      await expect(suggestion).toBeVisible();
      await expect(page.getByText(/No sheet has that name/u)).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`read-suggestions-${theme}-${String(width)}.png`),
        fullPage: true,
      });
      await suggestion.click();
      await expect(sheet).toHaveValue('Q2 2026');
      await expect.poll(() => saved()?.config.sheet).toBe('Q2 2026');

      await runTest(page, 'Run another test');
      await expect(
        page.getByRole('region', { name: 'Test result' }),
      ).toContainText('Bergen');
      await page.getByRole('tab', { name: 'Setup', exact: true }).click();
      const table = page.getByRole('table', {
        name: 'First rows from the last test',
      });
      await expect(table.getByRole('columnheader')).toHaveText([
        'region',
        'city',
        'sales',
        'paid',
      ]);
      await expect(table.getByRole('row')).toHaveCount(5);
      await expect(
        page.getByText('4 of 5 rows from the last test.'),
      ).toBeVisible();
      // The frame keeps its size from placeholder to rows.
      expect((await grid.boundingBox())?.height).toBe(before?.height);
      await page.screenshot({
        path: info.outputPath(`read-rows-${theme}-${String(width)}.png`),
        fullPage: true,
      });
      await page
        .getByRole('textbox', { name: 'Header row', exact: true })
        .fill('3');
      await expect.poll(() => saved()?.config.headerRow).toBe(3);
      await expect(
        page.getByText('Before your edits', { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });

for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 990, 1440])
    test(`writes an Excel sheet with ordered columns in ${theme} at ${String(width)}px`, async ({
      page,
      context,
    }, info) => {
      await prepare(page, theme, width);
      await addCsrfCookie(context);
      const data = [
        { currency: 'EUR', amount: 12.5, paid: true, note: '=SUM(A1)' },
      ];
      const remote = remoteDraft({
        nodes: [
          {
            id: 'create',
            label: 'Prepare workbook',
            definition: { key: 'core.create_file', version: 1 },
            configVersion: 1,
            config: { format: 'json' },
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
      await openStepSetup(page, { nodeId: 'create', width });
      await page.getByRole('button', { name: 'Excel', exact: true }).click();
      await expect
        .poll(() => saved()?.config)
        .toEqual({ format: 'xlsx', sheetName: 'Sheet1', columns: [] });
      const table = page.getByRole('table', { name: 'How the sheet starts' });
      await expect(table.getByRole('columnheader')).toHaveText([
        'currency',
        'amount',
        'paid',
        'note',
      ]);
      const add = page.getByRole('textbox', {
        name: 'Columns, in output order',
      });
      await add.fill('paid');
      await add.press('Enter');
      await add.fill('currency');
      await page
        .getByRole('button', { name: 'Add column', exact: true })
        .click();
      await expect
        .poll(() => saved()?.config.columns)
        .toEqual(['paid', 'currency']);
      await page
        .getByRole('button', { name: 'Move currency up', exact: true })
        .click();
      await expect
        .poll(() => saved()?.config.columns)
        .toEqual(['currency', 'paid']);
      await expect(table.getByRole('columnheader')).toHaveText([
        'currency',
        'paid',
      ]);
      await expect(table.getByRole('cell')).toHaveText(['EUR', 'true']);
      await add.fill('paid');
      await add.press('Enter');
      await expect(page.getByText('Choose each column once.')).toBeVisible();
      const name = page.getByRole('textbox', {
        name: 'Sheet name',
        exact: true,
      });
      await name.fill('Q3: final');
      await name.blur();
      await expect(page.getByText(/Sheet names cannot use/u)).toBeVisible();
      await name.fill('Q3 final');
      await expect.poll(() => saved()?.config.sheetName).toBe('Q3 final');
      await page.screenshot({
        path: info.outputPath(`create-${theme}-${String(width)}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
