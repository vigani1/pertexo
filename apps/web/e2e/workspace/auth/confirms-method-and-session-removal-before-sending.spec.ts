import { expect, test } from '../../support/fixtures';

import { csrfToken, mockIdentity, user } from './fixture';

test('confirms method and session removal before sending security commands', async ({
  page,
}) => {
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await mockIdentity(page, { authenticated: true });
  let removedMethods = 0;
  let endedSessions = 0;
  let methods = [
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      kind: 'password',
      provider: null,
    },
    {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      kind: 'social',
      provider: 'google',
    },
  ];
  let sessions = [
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', current: true },
    { id: '99999999-9999-4999-8999-999999999999', current: false },
  ];
  await page.route('**/v1/auth/account-security', async (route) => {
    await route.fulfill({
      json: {
        email: user.email,
        emailVerified: true,
        availableProviders: ['google'],
        twoFactor: { enabled: false, recoveryCodesRemaining: null },
        methods,
      },
    });
  });
  await page.route('**/v1/auth/account-security/sessions', async (route) => {
    await route.fulfill({
      json: {
        items: sessions.map((session) => ({
          ...session,
          createdAt: '2026-09-22T20:00:00.000Z',
          updatedAt: '2026-09-22T20:05:00.000Z',
          expiresAt: '2026-09-29T20:00:00.000Z',
          ipAddress: null,
          userAgent: session.current ? 'This browser' : 'Other Chromium',
        })),
      },
    });
  });
  await page.route(
    '**/v1/auth/account-security/methods/unlink',
    async (route) => {
      removedMethods += 1;
      expect(route.request().postDataJSON()).toMatchObject({
        methodId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });
      methods = methods.filter((method) => method.provider !== 'google');
      await route.fulfill({ json: { unlinked: true } });
    },
  );
  await page.route(
    '**/v1/auth/account-security/sessions/revoke-others',
    async (route) => {
      endedSessions += 1;
      sessions = sessions.filter((session) => session.current);
      await route.fulfill({ json: { revokedCount: 1 } });
    },
  );

  await page.goto('/account/security');
  await page.getByRole('tab', { name: 'Sign-in & security' }).click();
  await page.getByRole('button', { name: 'Remove Google' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Remove sign-in method?' }),
  ).toBeVisible();
  expect(removedMethods).toBe(0);
  await page.getByRole('button', { name: 'Keep method' }).click();
  expect(removedMethods).toBe(0);
  await page.getByRole('button', { name: 'Remove Google' }).click();
  await page.getByRole('button', { name: 'Remove method' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Remove sign-in method?' }),
  ).toBeHidden();
  expect(removedMethods).toBe(1);
  await expect(
    page.getByRole('list', { name: 'Sign-in methods' }).getByText('Google'),
  ).toHaveCount(0);

  await page.getByRole('tab', { name: 'Sessions' }).click();
  await page
    .getByRole('button', { name: 'Sign out all other devices' })
    .click();
  const confirmation = page.getByRole('dialog', {
    name: 'Sign out all other devices?',
  });
  await expect(confirmation).toBeVisible();
  expect(endedSessions).toBe(0);
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  expect(endedSessions).toBe(0);
  await page
    .getByRole('button', { name: 'Sign out all other devices' })
    .click();
  await confirmation
    .getByRole('button', { name: 'Sign out', exact: true })
    .click();
  await expect(page.getByText('No other devices are signed in.')).toBeVisible();
  expect(endedSessions).toBe(1);
});

test('requires an existing-method challenge before starting provider linking', async ({
  page,
}) => {
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await mockIdentity(page, { authenticated: true });
  await page.route('**/v1/auth/account-security', async (route) => {
    await route.fulfill({
      json: {
        email: user.email,
        emailVerified: true,
        availableProviders: ['google'],
        twoFactor: { enabled: false, recoveryCodesRemaining: null },
        methods: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            kind: 'password',
            provider: null,
          },
        ],
      },
    });
  });
  await page.route('**/v1/auth/account-security/sessions', async (route) => {
    await route.fulfill({ json: { items: [] } });
  });
  let starts = 0;
  await page.route(
    '**/v1/auth/account-security/methods/link/start',
    async (route) => {
      starts += 1;
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      expect(route.request().postDataJSON()).toEqual({
        provider: 'google',
        existingMethod: {
          kind: 'password',
          password: 'correct horse battery staple',
        },
      });
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://pertexo.test/problems/auth.provider_unavailable',
          title: 'Provider unavailable',
          status: 503,
          code: 'auth.provider_unavailable',
          requestId: 'browser-request-1234',
        }),
      });
    },
  );

  await page.goto('/account/security');
  await page.getByRole('tab', { name: 'Sign-in & security' }).click();
  await page.getByRole('button', { name: 'Add a sign-in method' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a sign-in method' });
  await dialog.getByRole('button', { name: 'Continue to Google' }).click();
  await expect(dialog.getByLabel('Current password')).toBeFocused();
  expect(starts).toBe(0);
  await dialog
    .getByLabel('Current password')
    .fill('correct horse battery staple');
  await dialog.getByRole('button', { name: 'Continue to Google' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(starts).toBe(1);
});
