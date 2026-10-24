import { createUserFixture } from '../../test/support/fixtures/identity';
import { test, expect } from '../support/fixtures';
const profile = createUserFixture({
  email: 'factor@example.test',
  displayName: 'Factor owner',
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
});
const codes = Array.from(
  { length: 10 },
  (_, i) => `code-${String(i).padStart(5, '0')}`,
);
for (const width of [1280, 375]) {
  test(`two-factor setup and challenge at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    let authenticated = true;
    let enabled = false;
    await page.context().addCookies([
      {
        name: 'pertexo_csrf',
        value: 'csrf-token-browser-two-factor-12345678901234567890',
        url: 'http://127.0.0.1:4173',
      },
    ]);
    await page.route('**/v1/users/me', (route) =>
      authenticated
        ? route.fulfill({ json: profile })
        : route.fulfill({
            status: 401,
            contentType: 'application/problem+json',
            json: {
              type: 'https://pertexo.test/problems/auth.unauthenticated',
              title: 'Authentication required',
              status: 401,
              code: 'auth.unauthenticated',
              requestId: 'browser-two-factor-request',
            },
          }),
    );
    await page.route('**/v1/workspaces?**', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route('**/v1/auth/capabilities', (route) =>
      route.fulfill({
        json: {
          password: {
            enabled: true,
            minimumLength: 12,
            verificationRequired: true,
          },
          socialProviders: [],
        },
      }),
    );
    await page.route('**/v1/auth/account-security', (route) =>
      route.fulfill({
        json: {
          email: profile.email,
          emailVerified: true,
          availableProviders: [],
          methods: [
            {
              id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              kind: 'password',
              provider: null,
            },
          ],
          twoFactor: { enabled, recoveryCodesRemaining: enabled ? 10 : null },
        },
      }),
    );
    await page.route('**/v1/auth/two-factor/enable', (route) => {
      expect(route.request().headers()['x-csrf-token']).toBeTruthy();
      return route.fulfill({
        json: {
          totpURI:
            'otpauth://totp/Pertexo:test?secret=JBSWY3DPEHPK3PXP&issuer=Pertexo',
          backupCodes: codes,
        },
      });
    });
    await page.route('**/v1/auth/two-factor/verify-totp', (route) => {
      expect(route.request().postDataJSON()).toEqual({ code: '123456' });
      enabled = true;
      authenticated = true;
      return route.fulfill({ json: { user: profile } });
    });
    await page.route('**/v1/auth/sign-in/email', (route) =>
      route.fulfill({
        json: { twoFactorRedirect: true, twoFactorMethods: ['totp'] },
      }),
    );
    await page.goto('/account/security');
    await page.getByRole('tab', { name: 'Sign-in & security' }).click();
    await page
      .getByRole('button', { name: 'Turn on two-factor sign-in' })
      .click();
    await page
      .getByRole('dialog')
      .getByLabel('Current password')
      .fill('correct horse battery staple');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Continue', exact: true })
      .click();
    await expect(
      page.getByRole('img', { name: /Scan this QR code/u }),
    ).toBeVisible();
    await page
      .getByLabel('Authenticator code', { exact: true })
      .fill('123 456');
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(
      page.getByRole('list', { name: 'Recovery codes' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Done', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('checkbox', { name: 'I’ve saved these codes' })
      .check();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(
      page.getByText('On · 10 recovery codes remaining'),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    authenticated = false;
    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(profile.email);
    await page
      .getByLabel('Password', { exact: true })
      .fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByLabel('Authenticator code', { exact: true }),
    ).toHaveAttribute('inputmode', 'numeric');
    await page
      .getByRole('button', { name: 'Use a recovery code instead' })
      .click();
    await expect(
      page.getByLabel('Recovery code', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Use an authenticator code instead' })
      .click();
    await page.getByLabel('Authenticator code', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page).toHaveURL('/workspaces');
  });
}
