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

  // Tab to the email field; VoiceOver names it as it gets focus.
  const said = async () => (await voiceOver.spokenPhraseLog()).join(' | ');
  for (let step = 0; step < 4; step++) {
    await voiceOver.press('Tab');
    if (/Email/u.test(await voiceOver.lastSpokenPhrase())) break;
  }
  expect(await voiceOver.lastSpokenPhrase()).toMatch(/Email/u);
  await page.keyboard.type('operator@example.test');

  // Sending without a password says what is missing.
  await voiceOver.press('Enter');
  await expect.poll(said).toMatch(/Enter your password/u);

  await voiceOver.press('Tab');
  expect(await voiceOver.lastSpokenPhrase()).toMatch(/Password/u);
  await page.keyboard.type('correct horse battery staple');
  await voiceOver.press('Enter');
  await expect(page).toHaveURL(`/w/${workspaceId}`);
});
