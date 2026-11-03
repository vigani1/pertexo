import { createWorkspaceFixture } from '../../../test/support/fixtures/identity';
import { expect, test } from '../../support/fixtures';
import {
  userId,
  workspaceId,
  firstMemberId,
  timestamp,
  member,
  installRoutes,
} from './fixture';

for (const width of [390, 1280]) {
  test(`explains unconfirmed invitation delivery and offers revoke recovery at ${String(width)} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await installRoutes(page);
    await page.route('**/v1/workspaces?**', (route) =>
      route.fulfill({
        json: {
          items: [
            createWorkspaceFixture({
              id: workspaceId,
              role: 'owner',
              capabilities: ['workspace:read', 'member:read', 'member:manage'],
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          ],
          nextCursor: null,
        },
      }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/invitations?**`,
      (route) =>
        route.fulfill({
          json: {
            issuanceAvailable: true,
            items: [
              {
                id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                email: 'uncertain@example.test',
                role: 'builder',
                status: 'pending',
                revision: 1,
                deliveryStatus: 'unknown',
                expiresAt: '2099-11-10T10:00:00.000Z',
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
            nextCursor: null,
          },
        }),
    );
    await page.goto(`/w/${workspaceId}/team?tab=invitations`);
    await expect(page.getByText('Delivery unconfirmed')).toBeVisible();
    await expect(
      page.getByText(
        'Email delivery could not be confirmed. Revoke this invitation and create a new one to send another link.',
      ),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Actions for uncertain@example.test' })
      .click();
    await expect(
      page.getByRole('menuitem', { name: 'Send a new link' }),
    ).toBeDisabled();
    await expect(
      page.getByRole('menuitem', { name: 'Revoke invitation' }),
    ).toBeEnabled();
    await page.keyboard.press('Escape');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

for (const width of [390, 1280]) {
  test(`shows recovery-owner preparation steps without losing Team access at ${String(width)} pixels`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.context().addCookies([
      {
        name: 'pertexo_csrf',
        value: 'recovery-owner-browser-proof-123456',
        url: baseURL ?? 'http://127.0.0.1:4173',
      },
    ]);
    await installRoutes(page);
    await page.route('**/v1/workspaces?**', (route) =>
      route.fulfill({
        json: {
          items: [
            createWorkspaceFixture({
              id: workspaceId,
              role: 'owner',
              capabilities: [
                'workspace:read',
                'workspace:manage',
                'member:read',
                'member:manage',
              ],
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          ],
          nextCursor: null,
        },
      }),
    );
    await page.route(`**/v1/workspaces/${workspaceId}/members?**`, (route) =>
      route.fulfill({
        json: {
          items: [
            member(userId, 'Owner', 'owner'),
            member(firstMemberId, 'Successor', 'admin'),
          ],
          nextCursor: null,
        },
      }),
    );
    let attempts = 0;
    await page.route(
      `**/v1/workspaces/${workspaceId}/members/${firstMemberId}/transfer-ownership`,
      (route) => {
        attempts += 1;
        return route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'urn:pertexo:problem:workspace.recovery_owner_ineligible',
            title: 'Recovery account required for ownership transfer',
            status: 409,
            code: 'workspace.recovery_owner_ineligible',
            requestId: 'recovery-owner-fixture',
            detail:
              'The new owner must verify their email and set up a password. Ask them to finish both in Account security, then retry the transfer.',
          }),
        });
      },
    );
    await page.goto(`/w/${workspaceId}/team`);
    await page.getByRole('button', { name: 'Actions for Successor' }).click();
    await page.getByRole('menuitem', { name: 'Make owner…' }).click();
    const dialog = page.getByRole('dialog', {
      name: /Make Successor the owner/u,
    });
    await dialog
      .getByRole('button', { name: 'Make owner', exact: true })
      .click();
    await expect(
      page.getByText(/verify their email and set up a password/u),
    ).toBeVisible();
    await expect(
      page.getByText(/Account security, then retry the transfer/u),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Team', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Actions for Successor' }),
    ).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(attempts).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
