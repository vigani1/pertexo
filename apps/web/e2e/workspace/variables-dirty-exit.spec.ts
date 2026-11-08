import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
} from '../workflow-editor/support';

for (const width of [375, 1280]) {
  test(`keeps variable edits when reload and navigation are declined at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: {
        ...workspace,
        capabilities: [...workspace.capabilities, 'variable:manage'],
      },
    });
    await addCsrfCookie(context);
    let writes = 0;
    await page.route(
      `**/v1/workspaces/${workspaceId}/variables`,
      async (route) => {
        if (route.request().method() === 'GET')
          return route.fulfill({
            json: {
              revision: 1,
              values: { RATE: 10 },
              descriptions: {},
            },
          });
        writes++;
        return route.fulfill({
          json: { revision: 2, changed: true, replayed: false },
        });
      },
    );
    await page.goto(`/w/${workspaceId}/settings/variables`);
    await page.getByRole('button', { name: 'Edit RATE', exact: true }).click();
    const value = page
      .getByRole('region', { name: 'RATE', exact: true })
      .getByLabel('Value', { exact: true });
    await value.fill('75');
    const dialog = page.waitForEvent('dialog', { timeout: 5_000 });
    const reload = page.evaluate(() => {
      window.location.reload();
    });
    const unload = await dialog;
    expect(unload.type()).toBe('beforeunload');
    await unload.dismiss();
    await reload;
    await expect(value).toHaveValue('75');
    if (width === 375)
      await page
        .getByRole('button', {
          name: 'Settings section: Variables. Choose another',
          exact: true,
        })
        .click();
    await page
      .getByRole('link', { name: 'Usage', exact: true })
      .filter({ visible: true })
      .click();
    const guard = page.getByRole('dialog', {
      name: 'Leave unsaved variables?',
    });
    await expect(guard).toBeVisible();
    await guard
      .getByRole('button', { name: 'Keep editing', exact: true })
      .click();
    await expect(value).toHaveValue('75');
    await expect(page).toHaveURL(`/w/${workspaceId}/settings/variables`);
    expect(writes).toBe(0);
  });
}
