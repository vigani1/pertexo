import { expect, test } from '../../support/fixtures';

import { mockIdentity, user } from './fixture';

test('sends a fresh verification link again after reload without repeating signup', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  let signupCount = 0;
  const resendAddresses: string[] = [];
  await page.route('**/v1/auth/sign-up/email', async (route) => {
    signupCount += 1;
    await route.fulfill({ json: { user: null } });
  });
  await page.route('**/v1/auth/send-verification-email', async (route) => {
    resendAddresses.push(
      (route.request().postDataJSON() as { email: string }).email,
    );
    await route.fulfill({ json: { status: true } });
  });
  const requestNewLink = async () => {
    await page.goto('/login?error=verification_invalid');
    await page.getByRole('button', { name: 'Send a new link' }).click();
    await page.getByLabel('Email').fill('operator@example.test');
    await page.getByRole('button', { name: 'Send link' }).click();
  };
  await requestNewLink();
  await expect(
    page.getByRole('heading', { name: 'Verify your email' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Resend in/u })).toBeDisabled();
  await page.reload();
  await requestNewLink();
  await expect.poll(() => resendAddresses.length).toBe(2);
  expect(resendAddresses).toEqual([
    'operator@example.test',
    'operator@example.test',
  ]);
  expect(signupCount).toBe(0);
});

test('recovers password recovery after a capabilities outage without exposing account existence', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  let available = false;
  await page.route('**/v1/auth/capabilities', async (route) => {
    if (!available) {
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://pertexo.test/problems/provider.unavailable',
          title: 'Authentication unavailable',
          status: 503,
          code: 'provider.unavailable',
          requestId: 'capabilities-outage',
        }),
      });
      return;
    }
    await route.fulfill({
      json: {
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: [],
        signUp: 'open',
      },
    });
  });
  let resetRequests = 0;
  await page.route('**/v1/auth/request-password-reset', async (route) => {
    resetRequests += 1;
    expect(route.request().postDataJSON()).toMatchObject({
      email: 'unknown@example.test',
    });
    await route.fulfill({ json: { status: true } });
  });
  await page.goto('/forgot-password');
  await expect(
    page.getByText('Password recovery is not available right now.'),
  ).toBeVisible();
  expect(resetRequests).toBe(0);
  available = true;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByLabel('Email').fill('unknown@example.test');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/If an account exists for/u)).toBeVisible();
  expect(resetRequests).toBe(1);
});

test('distinguishes an invalid reset link from a lost completion response', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  let loseResponse = false;
  await page.route(
    '**/v1/auth/account-security/password/reset',
    async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        token: 'one-time-token',
      });
      if (loseResponse) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://pertexo.test/problems/auth.reset_link_invalid',
          title: 'Reset link invalid or expired',
          status: 400,
          code: 'auth.reset_link_invalid',
          requestId: 'invalid-reset',
        }),
      });
    },
  );
  await page.goto('/reset-password?token=one-time-token');
  await page
    .getByLabel('New password', { exact: true })
    .fill('a new secure password value');
  await page
    .getByLabel('Confirm new password', { exact: true })
    .fill('a new secure password value');
  await page.getByRole('button', { name: 'Reset password' }).click();
  // A refused link can't be fixed from the form, so the page says so and
  // offers the way on instead.
  await expect(
    page.getByRole('heading', { name: 'This reset link has expired' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Request a new link' }),
  ).toBeVisible();

  loseResponse = true;
  await page.goto('/reset-password?token=one-time-token');
  await page
    .getByLabel('New password', { exact: true })
    .fill('a new secure password value');
  await page
    .getByLabel('Confirm new password', { exact: true })
    .fill('a new secure password value');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(
    page.getByText(/Your password may have changed; try signing in/u),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Try signing in' }),
  ).toBeVisible();
});

test('keeps account security understandable and usable on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
    await route.fulfill({
      json: {
        items: [
          {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            current: true,
            createdAt: '2026-09-22T20:00:00.000Z',
            updatedAt: '2026-09-22T20:05:00.000Z',
            expiresAt: '2026-09-29T20:00:00.000Z',
            ipAddress: null,
            userAgent: 'Chromium',
          },
        ],
      },
    });
  });

  await page.goto('/account/security');
  await expect(
    page.getByRole('heading', { name: 'Account & security' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Name and email' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'This account' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('tab', { name: 'Sign-in & security' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign-in methods' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Password', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('tab', { name: 'Sessions' }).click();
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
