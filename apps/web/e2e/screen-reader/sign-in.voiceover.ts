import { voiceOverTest as test } from '@guidepup/playwright';
import { expect } from '@playwright/test';
import { mockIdentity, workspaceId } from '../workspace/auth/fixture';

test('VoiceOver reads the sign-in fields and their refusal, and the user signs in', async ({
  page,
  voiceOver,
}) => {
  await mockIdentity(page, { authenticated: false });
  await page.goto('/login', { waitUntil: 'load' });
  await expect(
    page.getByRole('heading', { name: 'Sign in to continue' }),
  ).toBeVisible();
  await voiceOver.navigateToWebContent();

  // VoiceOver follows keyboard focus and names each field it lands on.
  const said = async () => (await voiceOver.spokenPhraseLog()).join(' | ');
  const heard = () => voiceOver.lastSpokenPhrase();
  await page.getByRole('textbox', { name: 'Email' }).focus();
  await expect.poll(heard).toMatch(/Email/u);
  await page.keyboard.type('operator@example.test');

  // Sending without a password says what is missing.
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => `${await said()} | ${await heard()}`)
    .toMatch(/Enter your password/u);

  await page.getByRole('textbox', { name: 'Password' }).focus();
  await expect.poll(heard).toMatch(/Password/u);
  await page.keyboard.type('correct horse battery staple');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/w/${workspaceId}`);
});
