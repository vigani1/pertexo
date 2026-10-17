import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { dataTablesResponseSchema } from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  addSingleStep,
  readEditorDraft,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
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
      page.getByText('No tables yet.', { exact: true }),
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
    await create
      .getByRole('button', { name: 'Create table', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Orders', exact: true }),
    ).toBeVisible();
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
    await importing
      .getByLabel('Or paste CSV', { exact: true })
      .fill('key,amount\nbeta,7\ngamma,wrong');
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
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export this page', exact: true })
      .click();
    const file = await download;
    const local = await file.path();
    expect(await readFile(local, 'utf8')).toContain('"alpha","20"');
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
      .toEqual({ table: 'Orders' });
    await publishSingleStep(page, workflow);
    const runId = await startSingleStep(page, {});
    await waitForRun(page, workspaceId, runId, 'succeeded');
    const csrf = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'pertexo_csrf',
    );
    if (csrf === undefined) throw new Error('Owned CSRF cookie missing');
    const headers = {
      'x-csrf-token': decodeURIComponent(csrf.value),
      'Idempotency-Key': randomUUID(),
    };
    const rows = await page.request.post(
      `${tablePath}/${table.id}/rows/query`,
      { headers, data: { filters: [], limit: 100, offset: 0 } },
    );
    expect(rows.status()).toBe(200);
    expect(((await rows.json()) as { rows: unknown[] }).rows).toHaveLength(3);
  });
