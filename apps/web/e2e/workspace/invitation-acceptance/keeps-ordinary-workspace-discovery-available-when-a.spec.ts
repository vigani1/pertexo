import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../../test/support/fixtures/identity';

import { expect, test } from '../../support/fixtures';

import { csrfToken, intentId, workspaceId } from './fixture';

test('keeps ordinary workspace discovery available when a replacement binding rejects cleanup', async ({
  page,
}) => {
  let cleanupRequests = 0;
  await page.route(/\/v1\/invitation-acceptance$/, async (route) => {
    if (route.request().method() === 'DELETE') {
      cleanupRequests += 1;
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        json: {
          type: 'https://pertexo.test/problems/auth.forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'auth.forbidden',
          requestId: 'browser-replaced-invitation-binding',
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        state: 'completed',
        intentId,
        expiresAt: '2026-09-19T19:00:00.000Z',
        csrfToken,
        workspace: { id: workspaceId, name: 'Control Operations' },
        role: 'builder',
        membershipCreated: true,
      },
    });
  });
  await page.route('**/v1/users/me', async (route) => {
    await route.fulfill({
      json: createUserFixture({
        email: 'builder@example.test',
        displayName: 'Pertexo Builder',
        createdAt: '2026-09-19T10:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      }),
    });
  });
  await page.route('**/v1/workspaces?**', async (route) => {
    await route.fulfill({
      json: {
        items: [
          createWorkspaceFixture({
            id: workspaceId,
            role: 'builder',
            capabilities: ['workspace:read', 'workflow:read'],
            createdAt: '2026-09-19T10:00:00.000Z',
            updatedAt: '2026-09-19T10:00:00.000Z',
          }),
        ],
        nextCursor: null,
      },
    });
  });

  await page.goto('/invitations/accept');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(
    page.getByText(/couldn’t finish tidying up the invitation/iu),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to my workspaces' }).click();

  await expect(page).toHaveURL('/workspaces');
  expect(cleanupRequests).toBe(1);
});
