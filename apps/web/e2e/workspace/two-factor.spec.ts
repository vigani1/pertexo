import { createUserFixture } from '../../test/support/fixtures/identity';
import { test, expect, type Page } from '../support/fixtures';
import {
  expectFocusOn,
  expectSpoken,
  startScreenReader,
} from '../support/screen-reader';
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
  test(
    `two-factor setup and challenge at ${String(width)}px`,
    { tag: width === 375 ? '@every-browser' : [] },
    async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const account = await mockTwoFactor(page);
      await page.goto('/account/security');
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
      account.signOut();
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
      await page
        .getByLabel('Authenticator code', { exact: true })
        .fill('123456');
      await page.getByRole('button', { name: 'Verify code' }).click();
      await expect(page).toHaveURL('/workspaces');
    },
  );
}

/**
 * A signed-in account without two-factor sign-in, whose server accepts the
 * code 123456; signing out sends the next sign-in to the code challenge.
 */
async function mockTwoFactor(page: Page) {
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
        signUp: 'open',
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
  return {
    signOut: () => {
      authenticated = false;
    },
  };
}

test('a screen-reader user turns on two-factor sign-in from the keyboard', async ({
  page,
}) => {
  await mockTwoFactor(page);
  await page.goto('/account/security');
  await expect(
    page.getByRole('heading', { name: 'How you sign in' }),
  ).toBeVisible();
  await startScreenReader(page);
  const turnOn = page.getByRole('button', {
    name: 'Turn on two-factor sign-in',
  });
  await turnOn.focus();
  await page.keyboard.press('Enter');

  // The dialog names itself and puts the user in the password field.
  const dialog = page.getByRole('dialog');
  await expectFocusOn(page, 'textbox', 'Current password');
  await page.keyboard.type('correct horse battery staple');
  await page.keyboard.press('Enter');

  // The QR code has a text alternative and the code field is next.
  await expect(
    dialog.getByRole('img', { name: /Scan this QR code/u }),
  ).toBeVisible();
  const code = dialog.getByRole('textbox', { name: 'Authenticator code' });
  await code.focus();
  await page.keyboard.type('123456');
  await page.keyboard.press('Enter');

  // The codes step takes focus on its title, so reading starts there; the
  // codes are a named list, and Done waits for the confirmation.
  await expectFocusOn(page, 'heading', 'Save your recovery codes');
  await expectSpoken(page, /^heading, Save your recovery codes/u);
  await expect(
    dialog.getByRole('list', { name: 'Recovery codes' }),
  ).toBeVisible();
  const saved = dialog.getByRole('checkbox', {
    name: 'I’ve saved these codes',
  });
  await saved.focus();
  await page.keyboard.press('Space');
  await expect(saved).toBeChecked();
  await page.keyboard.press('Tab');
  await expectFocusOn(page, 'button', 'Done');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText('On · 10 recovery codes remaining'),
  ).toBeVisible();
  // Focus stays in the two-factor section it came from.
  await expectFocusOn(page, 'button', 'Get new recovery codes');
});
