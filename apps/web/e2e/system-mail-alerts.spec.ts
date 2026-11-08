import { expect, test } from './support/fixtures';
import {
  csrfToken,
  installRoutes,
  timestamp,
  workspaceId,
} from './connections/fixture';

const memberId = '11111111-1111-4111-8111-111111111111';
for (const width of [375, 1280]) {
  test(`saves a member-only server-mail alert at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const origin = testInfo.project.use.baseURL;
    if (origin === undefined) throw new Error('Owned browser origin missing');
    await context.addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: origin },
    ]);
    await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
    await installRoutes(page);
    await page.route(`**/v1/workspaces/${workspaceId}/members**`, (route) =>
      route.fulfill({
        json: {
          items: [
            {
              userId: memberId,
              displayName: 'Ada',
              email: 'ada@example.test',
              role: 'viewer',
              roleRevision: 1,
              membershipStatus: 'active',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          nextCursor: null,
        },
      }),
    );
    let config: unknown;
    await page.route(
      `**/v1/workspaces/${workspaceId}/failure-notification-destinations**`,
      async (route) => {
        const saved = {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          workspaceId,
          kind: 'system_mail',
          status: 'enabled',
          currentVersion: 1,
          config,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        if (route.request().method() === 'POST') {
          config = route.request().postDataJSON();
          await route.fulfill({ status: 201, json: { ...saved, config } });
        } else
          await route.fulfill({
            json: {
              items: config === undefined ? [] : [saved],
              systemMail: { available: true },
              nextCursor: null,
            },
          });
      },
    );
    await page.goto(`/w/${workspaceId}/alerts`);
    await page
      .getByRole('button', { name: 'Add destination', exact: true })
      .click();
    const sheet = page.getByRole('dialog', {
      name: 'Add destination',
      exact: true,
    });
    await sheet
      .getByRole('button', {
        name: "Send with this server's mail",
        exact: true,
      })
      .click();
    await sheet.getByLabel('Workspace member').click();
    await page
      .getByRole('option', { name: 'Ada · ada@example.test', exact: true })
      .click();
    await expect(sheet.getByLabel('Recipient email')).toHaveCount(0);
    await expect(sheet.getByLabel('Email connection')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await sheet.screenshot({
      path: testInfo.outputPath(`system-mail-${String(width)}.png`),
    });
    await sheet
      .getByRole('button', { name: 'Add destination', exact: true })
      .click();
    await expect(sheet).toHaveCount(0);
    expect(config).toEqual({ kind: 'system_mail', memberId });
    await expect(
      page.getByText("Ada · ada@example.test via this server's mail"),
    ).toBeVisible();
  });
}
