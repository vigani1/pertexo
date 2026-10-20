import { expect, test } from '../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  editorUrl,
} from '../workflow-editor/support';
import { settings as federation } from '../../test/features/federation/fixtures';

const pages = [
  ['settings/sso', 'Single sign-on'],
  ['settings/notifications', 'Notifications'],
  ['settings/promotion', 'Promotion'],
  ['data-tables', 'Data tables'],
  ['workflows/dddddddd-dddd-4ddd-8ddd-dddddddddddd/comments', 'Comments'],
  ['workflows/dddddddd-dddd-4ddd-8ddd-dddddddddddd/versions', 'Versions'],
  ['workflows/dddddddd-dddd-4ddd-8ddd-dddddddddddd/runs', 'Runs'],
] as const;

for (const [path, heading] of pages) {
  test(`keeps ${path} readable and navigable`, async ({ page }) => {
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: {
        ...workspace,
        capabilities: [
          ...workspace.capabilities,
          'workspace:manage',
          'member:read',
          'member:manage',
        ],
      },
    });
    await page.route('**/v1/workspaces/*/sso', (route) =>
      route.fulfill({ json: federation }),
    );
    await page.route('**/v1/workspaces/*/notifications/preferences', (route) =>
      route.fulfill({
        json: {
          revision: 0,
          mode: null,
          hour: 9,
          timeZone: 'UTC',
          defaults: { revision: 0, mode: 'off', hour: 9, timeZone: 'UTC' },
          effective: { mode: 'off', hour: 9, timeZone: 'UTC' },
          canManageDefaults: true,
          emailAvailable: true,
          emailUnavailableReason: null,
        },
      }),
    );
    await page.route('**/v1/workspaces/*/promotions/settings', (route) =>
      route.fulfill({
        json: { revision: 0, canConfigure: true, target: null },
      }),
    );
    await page.route('**/v1/workspaces/*/promotions/history?**', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route('**/v1/workspaces/*/promotions/candidates?**', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route('**/v1/workspaces/*/data-tables', (route) =>
      route.fulfill({
        json: {
          tables: [],
          quotas: {
            tableLimit: 20,
            columnLimit: 20,
            rowLimit: 10000,
            byteLimit: 52428800,
            tableCount: 0,
            storedBytes: 0,
          },
        },
      }),
    );
    await page.route('**/v1/workspaces/*/workflows/*/comments?**', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route('**/v1/workspaces/*/workflows/*/versions?**', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route('**/v1/workspaces/*/runs?**', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.goto(`/w/${workspaceId}/${path}`);
    await expect(
      page.getByRole('heading', { name: heading, exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText('Something broke on our side', { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/^Loading /)).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (path.startsWith('workflows/'))
      await expect(
        page.getByRole('link', { name: 'Build', exact: true }),
      ).toHaveAttribute('href', editorUrl);
  });
}
