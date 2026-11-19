import { expect, test } from '../support/fixtures';
import {
  expectFocusOn,
  expectSpoken,
  startScreenReader,
} from '../support/screen-reader';
import {
  mockIdentity,
  refusedCredentialsProblem,
  workspaceId,
} from '../workspace/auth/fixture';

test('a screen-reader user signs in with the keyboard, hearing each field and every refusal', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  let refuse = true;
  await page.route('**/v1/auth/sign-in/email', async (route) => {
    if (!refuse) {
      await route.fallback();
      return;
    }
    refuse = false;
    await route.fulfill({
      status: 400,
      contentType: 'application/problem+json',
      body: refusedCredentialsProblem(),
    });
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Sign in to continue', level: 1 }),
  ).toBeVisible();
  await startScreenReader(page);

  await page.keyboard.press('Tab');
  await expectFocusOn(page, 'link', 'Skip to content');
  await page.keyboard.press('Tab');
  await expectFocusOn(page, 'textbox', 'Email');
  await expectSpoken(page, /^textbox, Email/u);

  // Sending empty fields keeps focus on the first one and describes what is
  // missing, so the user hears it where they are.
  await page.keyboard.press('Enter');
  const email = page.getByRole('textbox', { name: 'Email', exact: true });
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveAccessibleDescription('Enter your email address.');

  await page.keyboard.type('operator@example.test');
  await page.keyboard.press('Tab');
  await expectFocusOn(page, 'textbox', 'Password');
  await page.keyboard.type('wrong horse battery staple');
  await page.keyboard.press('Enter');

  // A refusal is an alert, and focus returns to the password to fix it.
  await expect(page.getByRole('alert')).toContainText(
    'That email and password don’t match.',
  );
  await expectFocusOn(page, 'textbox', 'Password');

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('correct horse battery staple');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/w/${workspaceId}`);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
