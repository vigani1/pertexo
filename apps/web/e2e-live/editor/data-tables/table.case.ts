import {
  apiProblemSchema,
  dataTableResultSchema,
  dataTablesResponseSchema,
  workflowNodeRunOutputResponseSchema,
  workflowValidateResponseSchema,
} from '@pertexo/contracts';
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
import { test } from '../../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';
import { qualifyColumnNames } from './qualify-column-names';
import { qualifyLargeDownload } from './qualify-download';
for (const width of [1280, 375])
  test(`real typed data tables create, import, edit, export and execute at ${String(width)}px`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
    if (origin === undefined) throw new Error('Use the owned API fixture');
    await registerEditorUser(page, request, origin, 'Table owner');
    const workspaceId = await createEditorWorkspace(
      page,
      'Table qualification',
    );
    const tablePath = `/v1/workspaces/${workspaceId}/data-tables`;
    await page.goto(`/w/${workspaceId}/data-tables`);
    await expect(
      page.getByText('No tables yet', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Create a table to keep orders, reference values or workflow state here.',
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'New table', exact: true }).click();
    const create = page.getByRole('dialog', {
      name: 'New data table',
      exact: true,
    });
    await create.getByLabel('Table name', { exact: true }).fill('Orders');
    await create.getByLabel('Column name', { exact: true }).fill('key');
    await create.getByRole('switch', { name: 'Required', exact: true }).click();
    await create
      .getByRole('button', { name: 'Add column', exact: true })
      .click();
    await create
      .getByLabel('Column name', { exact: true })
      .nth(1)
      .fill('amount');
    await create.getByLabel('Column type', { exact: true }).nth(1).click();
    await page.getByRole('option', { name: 'number', exact: true }).click();
    await create.getByLabel('Unique key (optional)', { exact: true }).click();
    await page.getByRole('option', { name: 'key', exact: true }).click();
    await create.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(
      create.getByRole('button', { name: 'Create table', exact: true }),
    ).toBeFocused();
    await create
      .getByRole('button', { name: 'Create table', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Orders', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('No rows yet. Add a row or import CSV to start.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText('0 rows total', { exact: true })).toBeVisible();
    const list = await page.request.get(tablePath);
    expect(list.status()).toBe(200);
    const table = dataTablesResponseSchema.parse(await list.json()).tables[0];
    if (table === undefined) throw new Error('Created table missing');
    const writes: { body: string | null; key: string | undefined }[] = [];
    let lost = false;
    await page.route(`**${tablePath}/${table.id}/rows`, async (route) => {
      writes.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key'],
      });
      if (lost) return route.continue();
      lost = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      return route.fulfill({
        status: 502,
        json: {
          type: 'about:blank',
          status: 502,
          title: 'Lost acknowledgement',
          code: 'internal.unexpected',
        },
      });
    });
    await page.getByRole('button', { name: 'Add row', exact: true }).click();
    const add = page.getByRole('dialog', { name: 'Add row', exact: true });
    await add.getByLabel('key', { exact: false }).fill('alpha');
    await add.getByLabel('amount', { exact: false }).fill('12.5');
    await add.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(
      add.getByRole('button', { name: 'Save row', exact: true }),
    ).toBeFocused();
    await add.getByRole('button', { name: 'Save row', exact: true }).click();
    await add
      .getByRole('button', { name: 'Retry same action', exact: true })
      .click();
    await expect(add).not.toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    await page.unroute(`**${tablePath}/${table.id}/rows`);
    await expect(
      page.getByRole('row').filter({ hasText: 'alpha' }),
    ).toContainText('12.5');
    await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
    const importing = page.getByRole('dialog', {
      name: 'Import CSV',
      exact: true,
    });
    await expect(
      importing.getByText('Drop a file here or choose file', { exact: true }),
    ).toBeVisible();
    await importing
      .getByLabel('Choose a UTF-8 CSV file', { exact: true })
      .setInputFiles({
        name: 'orders.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('key,amount\nbeta,7\ngamma,wrong'),
      });
    await expect(
      importing.getByLabel('Or paste CSV', { exact: true }),
    ).toHaveValue('key,amount\nbeta,7\ngamma,wrong');
    await expect(
      importing.getByText('orders.csv', { exact: true }),
    ).toBeVisible();
    await importing
      .getByRole('button', { name: 'Cancel', exact: true })
      .focus();
    await page.keyboard.press('Tab');
    await expect(
      importing.getByRole('button', { name: 'Import rows', exact: true }),
    ).toBeFocused();
    await importing
      .getByRole('button', { name: 'Import rows', exact: true })
      .click();
    await expect(
      importing.getByText(/CSV row 3: Column amount needs number/u),
    ).toBeVisible();
    await importing
      .getByLabel('Or paste CSV', { exact: true })
      .fill('key,amount\nbeta,7\ngamma,9');
    await importing
      .getByRole('button', { name: 'Import rows', exact: true })
      .click();
    await expect(importing).not.toBeVisible();
    await expect(
      page.getByRole('row').filter({ hasText: 'beta' }),
    ).toContainText('7');
    await page.getByLabel('Value', { exact: true }).fill('missing-order');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(
      page.getByText('No rows match this filter. Try a different filter.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('0 matching rows', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Clear filter', exact: true })
      .click();
    await page
      .getByRole('row')
      .filter({ hasText: 'alpha' })
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    const edit = page.getByRole('dialog', { name: 'Edit row', exact: true });
    await edit.getByLabel('amount', { exact: false }).fill('20');
    await edit.getByRole('button', { name: 'Save row', exact: true }).click();
    await expect(edit).not.toBeVisible();
    await expect(
      page.getByRole('row').filter({ hasText: 'alpha' }),
    ).toContainText('20');
    await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
    const bulk = page.getByRole('dialog', { name: 'Import CSV', exact: true });
    await bulk
      .getByLabel('Or paste CSV', { exact: true })
      .fill(
        'key,amount\n' +
          Array.from(
            { length: 120 },
            (_, index) => `extra${String(index)},${String(index)}`,
          ).join('\n'),
      );
    await bulk
      .getByRole('button', { name: 'Import rows', exact: true })
      .click();
    await expect(bulk).not.toBeVisible();
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export all rows', exact: true })
      .click();
    const file = await download;
    const local = await file.path();
    const csv = await readFile(local, 'utf8');
    expect(csv).toContain('"alpha","20"');
    expect(csv).toContain('"extra119","119"');
    expect(csv.trimEnd().split('\r\n')).toHaveLength(124);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `/tmp/pertexo-f14-${String(width)}.png`,
      fullPage: true,
    });
    await qualifyLargeDownload(page, workspaceId);
    await page.goto(`/w/${workspaceId}/data-tables/${table.id}`);
    await page
      .getByRole('button', { name: 'Edit columns', exact: true })
      .click();
    const columns = page.getByRole('dialog', {
      name: 'Edit columns',
      exact: true,
    });
    await columns.getByLabel('Column name', { exact: true }).fill('currency');
    await columns
      .getByRole('checkbox', { name: 'Required column', exact: true })
      .click();
    await columns
      .getByLabel('Default for existing rows (required)', { exact: true })
      .fill('USD');
    await columns
      .getByRole('button', { name: 'Save column changes', exact: true })
      .click();
    await expect(columns).not.toBeVisible();
    await expect(
      page.getByRole('row').filter({ hasText: 'alpha' }),
    ).toContainText('USD');
    await page.setViewportSize({ width: 1280, height: 768 });
    const workflow = await createEditorWorkflow(
      page,
      workspaceId,
      'Find saved orders',
    );
    const nodeId = await addSingleStep(
      page,
      workflow,
      /Find rows/u,
      'Find saved rows',
    );
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.getByLabel('Workspace table', { exact: true }).click();
    await page.getByRole('option', { name: 'Orders', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await readEditorDraft(page, workflow)).graph.nodes.find(
            (node) => node.id === nodeId,
          )?.config,
      )
      .toMatchObject({
        table: 'Orders',
        columnBindings: { key: 'key', amount: 'amount' },
      });
    const version = await publishSingleStep(page, workflow);
    const runId = await startSingleStep(page, {});
    await waitForRun(page, workspaceId, runId, 'succeeded');
    await page.goto(`/w/${workspaceId}/data-tables/${table.id}`);
    await page.setViewportSize({ width, height: 768 });
    await page
      .getByRole('button', { name: 'Edit columns', exact: true })
      .click();
    await columns
      .getByRole('button', { name: 'Rename amount', exact: true })
      .click();
    await columns.getByLabel('Column name', { exact: true }).fill('total');
    await page.screenshot({
      path: `/tmp/pertexo-f14-columns-${String(width)}.png`,
      fullPage: true,
    });
    await columns
      .getByRole('button', { name: 'Save column changes', exact: true })
      .click();
    await expect(columns).not.toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: /total/u }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.goto(workflow.replace('/v1/workspaces/', '/w/'));
    const renamedRun = await startSingleStep(page, {});
    const completed = await waitForRun(
      page,
      workspaceId,
      renamedRun,
      'succeeded',
    );
    const completedNode = completed.nodes.find(
      (node) => node.nodeId === nodeId,
    );
    if (completedNode === undefined) throw new Error('Find result missing');
    const outputResponse = await page.request.get(
      `/v1/workspaces/${workspaceId}/runs/${renamedRun}/node-runs/${completedNode.id}/output`,
    );
    expect(outputResponse.ok()).toBe(true);
    const output = workflowNodeRunOutputResponseSchema.parse(
      await outputResponse.json(),
    ).output;
    if (output.kind !== 'inline')
      throw new Error('Expected inline Find output');
    const found = dataTableResultSchema.parse(output.value);
    expect(
      found.rows.find((row) => row.values.key === 'alpha')?.values,
    ).toEqual({ key: 'alpha', amount: 20, currency: 'USD' });
    const currentVersionId = await qualifyColumnNames({
      page,
      workspaceId,
      workflow,
      nodeId,
      originalVersionId: version.id,
      width,
    });
    await page.goto(`/w/${workspaceId}/data-tables/${table.id}`);
    await page.setViewportSize({ width, height: 768 });
    await page
      .getByRole('button', { name: 'Edit columns', exact: true })
      .click();
    await columns
      .getByRole('button', { name: 'Delete total', exact: true })
      .click();
    await expect(
      columns.getByText(/Delete total and its cells/u),
    ).toBeVisible();
    await columns
      .getByRole('button', { name: 'Confirm delete column', exact: true })
      .click();
    await expect(columns).not.toBeVisible();
    const csrf = await readCsrfToken(page, {
      missingMessage: 'Owned CSRF cookie missing',
    });
    const headers = {
      'x-csrf-token': csrf,
      'Idempotency-Key': randomUUID(),
    };
    const rows = await page.request.post(
      `${tablePath}/${table.id}/rows/query`,
      { headers, data: { filters: [], limit: 1000, offset: 0 } },
    );
    expect(rows.status()).toBe(200);
    expect(((await rows.json()) as { rows: unknown[] }).rows).toHaveLength(123);
    const checked = await page.request.post(`${workflow}/validate`, {
      headers,
      data: {},
    });
    expect(checked.ok()).toBe(true);
    const invalid = workflowValidateResponseSchema.parse(await checked.json());
    expect(invalid.valid).toBe(false);
    expect(
      invalid.issues.some((issue) => issue.message.includes('removed')),
    ).toBe(true);
    const tag = checked.headers().etag;
    if (tag === undefined) throw new Error('Checked draft tag missing');
    const refusedPublication = await page.request.post(`${workflow}/publish`, {
      headers: { ...headers, 'If-Match': tag, 'Idempotency-Key': randomUUID() },
      data: {},
    });
    expect(refusedPublication.status()).toBeGreaterThanOrEqual(400);
    expect(refusedPublication.status()).toBeLessThan(500);
    const refused = await page.request.post(`${workflow}/runs`, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: { input: {}, expectedPublishedVersionId: currentVersionId },
    });
    expect(refused.status()).toBe(400);
    expect(apiProblemSchema.parse(await refused.json()).detail).toContain(
      'removed',
    );
  });
