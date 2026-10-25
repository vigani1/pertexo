import { test, expect } from '../../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  addCsrfCookie,
} from '../../workflow-editor/support';

for (const width of [360, 1440])
  test(`empty rows, ordered actions and CSV drops at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: { ...workspace, role: 'owner' },
    });
    await addCsrfCookie(context);
    const id = '10000000-0000-4000-8000-000000000001';
    await page.route(`**/v1/workspaces/${workspaceId}/data-tables`, (route) =>
      route.fulfill({
        json: {
          tables: [
            {
              id,
              name: 'Orders',
              columns: [
                { id: 'name', name: 'name', type: 'text', required: true },
              ],
              keyColumn: null,
              hasRemovedColumns: false,
              rowCount: 0,
              storedBytes: 0,
              revision: 1,
            },
          ],
          quotas: {
            tableLimit: 20,
            columnLimit: 20,
            rowLimit: 10000,
            byteLimit: 52428800,
            tableCount: 1,
            storedBytes: 0,
          },
        },
      }),
    );
    await page.route('**/v1/workspaces/*/data-tables/*/rows/query', (route) =>
      route.fulfill({ json: { rows: [], affected: 0, hasMore: false } }),
    );
    await page.goto(`/w/${workspaceId}/data-tables/${id}`);
    await expect(
      page.getByText('No rows yet. Add a row or import CSV to start.'),
    ).toBeVisible();
    await expect(page.getByText('0 rows total')).toBeVisible();
    await page.getByLabel('Value', { exact: true }).fill('missing');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(
      page.getByText('No rows match this filter. Try a different filter.'),
    ).toBeVisible();
    await expect(page.getByText('0 matching rows')).toBeVisible();
    await page.getByRole('button', { name: 'Add row', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add row', exact: true });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.focus();
    await page.keyboard.press('Tab');
    await expect(
      dialog.getByRole('button', { name: 'Save row', exact: true }),
    ).toBeFocused();
    await cancel.click();
    await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
    const csv = page.getByRole('dialog', { name: 'Import CSV', exact: true });
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(
        new File(['name\nAda'], 'orders.csv', { type: 'text/csv' }),
      );
      return data;
    });
    await csv
      .locator('[data-slot="file-drop"]')
      .dispatchEvent('drop', { dataTransfer: transfer });
    await expect(csv.getByLabel('Or paste CSV')).toHaveValue('name\nAda');
    await expect(csv.getByText('orders.csv')).toBeVisible();
    await expect(csv.getByText('8 B')).toBeVisible();
    await csv.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(
      csv.getByRole('button', { name: 'Import rows', exact: true }),
    ).toBeFocused();
  });
