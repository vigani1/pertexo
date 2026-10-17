import { test, expect } from '../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  addCsrfCookie,
} from '../workflow-editor/support';
for (const width of [1280, 375])
  test(`table page preserves stale row edits and filters at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: { ...workspace, role: 'owner' },
    });
    await addCsrfCookie(context);
    const id = '10000000-0000-4000-8000-000000000001';
    const rowId = '10000000-0000-4000-8000-000000000002';
    let revision = 1;
    let amount = 12;
    let refused = false;
    const path = `**/v1/workspaces/${workspaceId}/data-tables`;
    await page.route(path, (route) =>
      route.fulfill({
        json: {
          tables: [
            {
              id,
              name: 'Orders',
              columns: [
                { name: 'key', type: 'text', required: true },
                { name: 'amount', type: 'number', required: true },
              ],
              keyColumn: 'key',
              rowCount: 1,
              storedBytes: 25,
              revision: 1,
            },
          ],
          quotas: {
            tableLimit: 20,
            columnLimit: 20,
            rowLimit: 10000,
            byteLimit: 52428800,
            tableCount: 1,
            storedBytes: 25,
          },
        },
      }),
    );
    await page.route(`${path}/${id}/rows/query`, (route) => {
      expect(route.request().headers()['x-csrf-token']).toBeTruthy();
      return route.fulfill({
        json: {
          rows: [{ id: rowId, revision, values: { key: 'alpha', amount } }],
          affected: 1,
          hasMore: false,
        },
      });
    });
    await page.route(`${path}/${id}/rows`, (route) => {
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      if (!refused) {
        refused = true;
        revision = 2;
        amount = 30;
        return route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: {
            type: 'about:blank',
            status: 409,
            title: 'Conflict',
            code: 'workspace.conflict',
            requestId: 'table-proof',
            detail: 'This row changed. Reload before saving.',
          },
        });
      }
      return route.fulfill({ json: { rows: [], affected: 1 } });
    });
    await page.goto(`/w/${workspaceId}/data-tables/${id}`);
    await expect(
      page.getByRole('row').filter({ hasText: 'alpha' }),
    ).toContainText('12');
    await page
      .getByRole('row')
      .filter({ hasText: 'alpha' })
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    const edit = page.getByRole('dialog', { name: 'Edit row', exact: true });
    await edit.getByLabel('amount', { exact: false }).fill('99');
    await edit.getByRole('button', { name: 'Save row', exact: true }).click();
    await expect(
      edit.getByText('This row changed. Reload before saving.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(edit.getByLabel('amount', { exact: false })).toHaveValue('99');
    await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page
      .getByRole('button', { name: 'Refresh rows', exact: true })
      .click();
    await expect(
      page.getByRole('row').filter({ hasText: 'alpha' }),
    ).toContainText('30');
    await page.getByLabel('Value', { exact: true }).fill('alpha');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(
      page.getByRole('row').filter({ hasText: 'alpha' }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
  });
