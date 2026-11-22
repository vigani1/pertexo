import { expect, type Page } from '@playwright/test';
import { test } from './account';
import { modelScreenshots } from './model-editor';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  publishSingleStep,
} from '../../support/authoring/single-step';
import { saveGraph } from '../callable/fixture';

test.use({
  accountGroup: 'evaluation',
  viewport: { width: 1280, height: 1080 },
  reducedMotion: 'reduce',
});

test('evaluates a published Switch against table rows and inspects its branch score', async ({
  page,
}, info) => {
  const workspaceId = await openNewEditorWorkspace(
    page,
    'Evaluation workspace',
  );
  await createCaseTable(page, workspaceId);
  const workflow = await createEditorWorkflow(page, workspaceId, 'Route cases');
  await saveGraph(page, workflow, {
    nodes: [
      {
        id: 'route',
        definition: { key: 'core.switch', version: 1 },
        label: 'Route case',
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: { cases: [{ id: 'case-01', equals: 'billing' }] },
        inputMappings: { value: { kind: 'run_input', path: '$.category' } },
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  });
  await page.reload();
  await publishSingleStep(page, workflow);
  await page
    .getByRole('button', { name: 'More test actions', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'Evaluate data table', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Evaluate data table',
    exact: true,
  });
  await dialog.getByLabel('Workflow version', { exact: true }).click();
  await page.getByRole('option', { name: 'Version 1', exact: true }).click();
  await dialog.getByLabel('Case table', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Routing cases', exact: true })
    .click();
  await dialog.getByLabel('category', { exact: true }).fill('category');
  await dialog
    .getByRole('button', { name: 'Add value check', exact: true })
    .click();
  const check = dialog.getByRole('group', { name: 'Check 1', exact: true });
  await check.getByLabel('Output', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Route case (route)', exact: true })
    .click();
  await check
    .getByRole('button', { name: 'Use selected branch', exact: true })
    .click();
  await check
    .getByLabel('Expected value (JSON)', { exact: true })
    .fill('"case-01"');
  const started = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${workflow}/draft/test-suites`) &&
      response.request().method() === 'POST',
  );
  await dialog
    .getByRole('button', { name: 'Start evaluation', exact: true })
    .click();
  const accepted = await started;
  expect(accepted.status(), await accepted.text()).toBe(202);
  await expect(
    page.getByText('1/2 assertions passed', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole('button', { name: 'View test Row 1', exact: true })
    .click();
  await expect(page.getByText('Version 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Report Row 1', exact: true }).click();
  await expect(
    page.getByText(/Step Route case · \$\.selectedPort/u),
  ).toBeVisible();
  await modelScreenshots(page, info, 'table-evaluation');
});

async function createCaseTable(page: Page, workspaceId: string) {
  await page.goto(`/w/${workspaceId}/data-tables`);
  await page.getByRole('button', { name: 'New table', exact: true }).click();
  const create = page.getByRole('dialog', {
    name: 'New data table',
    exact: true,
  });
  await create.getByLabel('Table name', { exact: true }).fill('Routing cases');
  await create.getByLabel('Column name', { exact: true }).fill('category');
  await create
    .getByRole('button', { name: 'Create table', exact: true })
    .click();
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const importing = page.getByRole('dialog', {
    name: 'Import CSV',
    exact: true,
  });
  await importing
    .getByLabel('Choose a UTF-8 CSV file', { exact: true })
    .setInputFiles({
      name: 'cases.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('category\nbilling\naccess\n'),
    });
  await importing
    .getByRole('button', { name: 'Import rows', exact: false })
    .click();
  const rows = page.getByRole('table', {
    name: 'Routing cases rows',
    exact: true,
  });
  await expect(
    rows.getByRole('cell', { name: 'billing', exact: true }),
  ).toBeVisible();
  await expect(
    rows.getByRole('cell', { name: 'access', exact: true }),
  ).toBeVisible();
}
