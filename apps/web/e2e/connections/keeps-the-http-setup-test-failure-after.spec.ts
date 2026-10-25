import {
  connectionId,
  csrfToken,
  installRoutes,
  secretVersionId,
  timestamp,
  workspaceId,
} from './fixture';

import { expect, test } from '../support/fixtures';

for (const width of [390, 1280]) {
  test(`keeps the HTTP setup-test failure after a reload at ${String(width)} pixels`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await context.addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
    await installRoutes(page);
    let created = false;
    let health = {
      lastTestedAt: null as string | null,
      lastHealthyAt: null as string | null,
      lastErrorCode: null as string | null,
    };
    const connection = () => ({
      id: connectionId,
      workspaceId,
      providerKey: 'http',
      name: 'Billing API',
      authType: 'http_headers',
      status: 'active',
      secretVersionId,
      health,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await page.route(
      `**/v1/workspaces/${workspaceId}/connections?**`,
      (route) =>
        route.fulfill({
          json: { items: created ? [connection()] : [], nextCursor: null },
        }),
    );
    await page.route(`**/v1/workspaces/${workspaceId}/connections`, (route) => {
      created = true;
      return route.fulfill({ status: 201, json: connection() });
    });
    await page.route(
      `**/v1/workspaces/${workspaceId}/connections/${connectionId}/test`,
      (route) => {
        expect(route.request().postDataJSON()).toEqual({
          url: 'https://billing.example.test/me',
        });
        health = {
          lastTestedAt: timestamp,
          lastHealthyAt: null,
          lastErrorCode: 'connection.test.dns_failed',
        };
        return route.fulfill({
          json: {
            connection: connection(),
            outcome: {
              ok: false,
              httpStatus: null,
              errorCode: 'connection.test.dns_failed',
            },
          },
        });
      },
    );
    await page.goto(`/w/${workspaceId}/connections?add=http`);
    const lens = page.locator('[data-slot="sheet-content"]');
    await lens.getByLabel('Header 1 value').fill('Bearer setup-secret');
    await lens.getByRole('button', { name: 'Continue' }).click();
    await lens.getByLabel('Connection name').fill('Billing API');
    await lens.getByRole('button', { name: 'Save and test' }).click();
    await lens
      .getByLabel('Address to call')
      .fill('https://billing.example.test/me');
    await lens.getByRole('button', { name: 'Call this address' }).click();
    await expect(
      lens.getByText('The test failed: address not found.'),
    ).toBeVisible();
    await lens.getByRole('button', { name: 'Done' }).click();
    await expect(
      page.getByText('last test failed · address not found'),
    ).toBeVisible();
    await expect(page.getByText('never tested')).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByText('last test failed · address not found'),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/pertexo-polish-3-${String(width)}.png`,
    });
  });
}
