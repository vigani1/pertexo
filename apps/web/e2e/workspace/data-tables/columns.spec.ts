import { readFile } from 'node:fs/promises';
import {
  dataTableSchemaEditSchema,
  dataTableExportQuerySchema,
  type DataTableDefinition,
} from '@pertexo/contracts';
import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspaceId,
} from '../../workflow-editor/support';

for (const width of [1280, 375])
  test(`column edits retain exact uncertain requests and export the whole result at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installEditorRoutes(page, remoteDraft());
    await addCsrfCookie(context);
    let table: DataTableDefinition = {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Orders',
      columns: [
        { id: 'key', name: 'key', type: 'text', required: true },
        { id: 'amount', name: 'amount', type: 'number', required: true },
      ],
      keyColumn: 'key',
      hasRemovedColumns: false,
      rowCount: 120,
      storedBytes: 6000,
      revision: 1,
    };
    const path = `**/v1/workspaces/${workspaceId}/data-tables`;
    await page.route(path, (route) =>
      route.fulfill({
        json: {
          tables: [table],
          quotas: {
            tableLimit: 20,
            columnLimit: 20,
            rowLimit: 10000,
            byteLimit: 52428800,
            tableCount: 1,
            storedBytes: 6000,
          },
        },
      }),
    );
    await page.route(`${path}/${table.id}/rows/query`, (route) =>
      route.fulfill({
        json: {
          rows: Array.from({ length: 50 }, (_, index) => ({
            id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            revision: 1,
            values: {
              key: index === 0 ? 'alpha' : `row${String(index)}`,
              ...(table.columns.some((column) => column.id === 'amount')
                ? {
                    [table.columns.find((column) => column.id === 'amount')
                      ?.name ?? 'amount']: index,
                  }
                : {}),
            },
          })),
          affected: 50,
          hasMore: true,
        },
      }),
    );
    const edits: { body: unknown; key: string | undefined }[] = [];
    await page.route(`${path}/${table.id}/schema`, async (route) => {
      const body = dataTableSchemaEditSchema.parse(
        route.request().postDataJSON(),
      );
      edits.push({ body, key: route.request().headers()['idempotency-key'] });
      if (body.change.operation === 'rename_column') {
        const change = body.change;
        table = {
          ...table,
          revision: 2,
          columns: table.columns.map((column) =>
            column.id === change.columnId
              ? { ...column, name: change.name }
              : column,
          ),
        };
        if (edits.length === 1) return route.abort('failed');
      } else if (body.change.operation === 'remove_column') {
        const change = body.change;
        table = {
          ...table,
          revision: 3,
          hasRemovedColumns: true,
          columns: table.columns.filter(
            (column) => column.id !== change.columnId,
          ),
        };
      } else throw new Error('Unexpected schema operation');
      return route.fulfill({ json: { revision: table.revision } });
    });
    const exports: unknown[] = [];
    await page.route(`${path}/${table.id}/export`, (route) => {
      const body = dataTableExportQuerySchema.parse(
        route.request().postDataJSON(),
      );
      exports.push(body);
      const count = body.filters.length === 0 ? 120 : 1;
      const csv = [
        '"key","total"',
        ...Array.from(
          { length: count },
          (_, index) =>
            `"${index === 0 ? 'alpha' : `row${String(index)}`}","${String(index)}"`,
        ),
      ].join('\r\n');
      return route.fulfill({ json: { csv, rowCount: count } });
    });
    await page.goto(`/w/${workspaceId}/data-tables/${table.id}`);
    await page
      .getByRole('button', { name: 'Edit columns', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Edit columns',
      exact: true,
    });
    await dialog
      .getByRole('button', { name: 'Rename amount', exact: true })
      .click();
    await dialog.getByLabel('Column name', { exact: true }).fill('total');
    await dialog
      .getByRole('button', { name: 'Save column changes', exact: true })
      .click();
    await expect(
      dialog.getByLabel('Column name', { exact: true }),
    ).toBeDisabled();
    await expect(dialog.getByLabel('Column name', { exact: true })).toHaveValue(
      'total',
    );
    await dialog
      .getByRole('button', { name: 'Retry same action', exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    expect(edits).toHaveLength(2);
    expect(edits[0]?.key).toBeTruthy();
    expect(edits[1]).toEqual(edits[0]);
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export all rows', exact: true })
      .click();
    const file = await download;
    const csv = await readFile(await file.path(), 'utf8');
    expect(csv.split('\r\n')).toHaveLength(121);
    expect(csv).toContain('row119');
    expect(exports[0]).toEqual({ filters: [] });
    await page.getByLabel('Value', { exact: true }).fill('alpha');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    const filteredDownload = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export filtered rows', exact: true })
      .click();
    const filtered = await filteredDownload;
    expect(
      (await readFile(await filtered.path(), 'utf8')).split('\r\n'),
    ).toHaveLength(2);
    expect(exports[1]).toEqual({
      filters: [{ column: 'key', operator: 'equals', value: 'alpha' }],
    });
    await page
      .getByRole('button', { name: 'Edit columns', exact: true })
      .click();
    await dialog
      .getByRole('button', { name: 'Delete total', exact: true })
      .click();
    expect(edits).toHaveLength(2);
    await expect(dialog.getByText(/Delete total and its cells/u)).toBeVisible();
    await dialog
      .getByRole('button', { name: 'Confirm delete column', exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    expect(edits[2]?.body).toEqual({
      expectedRevision: 2,
      change: { operation: 'remove_column', columnId: 'amount', confirm: true },
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
