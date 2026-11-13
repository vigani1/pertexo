import { temporaryTestPath } from '../../test/support/temporary-test-path';
import { createHmac } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { test } from '../support/browser-fixture';
import { registerEditorUser } from '../support/ordinary-editor-session';
import { fillOwnedHttpCredential } from '../support/http-secret-actions';

const password = 'a long enough integration password';
function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/u, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid owned authenticator key');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', Buffer.from(bytes))
    .update(counter)
    .digest();
  return String(
    (digest.readUInt32BE((digest.at(-1) ?? 0) & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, '0');
}
async function signOut(page: Page) {
  await page.goto('/workspaces');
  await page
    .getByRole('button', { name: 'Account menu for Factor owner' })
    .click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('/login');
}
async function signIn(page: Page, email: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await fillOwnedHttpCredential(
    page.getByLabel('Password', { exact: true }),
    password,
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByLabel('Authenticator code', { exact: true }),
  ).toBeVisible();
}
test('authenticator at desktop and single-use recovery sign-in on a phone', async ({
  page,
  request,
}) => {
  const width = 1280;
  await page.setViewportSize({ width, height: 800 });
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail origin missing');
  const email = await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Factor owner',
  );
  await page.goto('/account/security');
  await page.getByRole('tab', { name: 'Sign-in & security' }).click();
  await page
    .getByRole('button', { name: 'Turn on two-factor sign-in', exact: true })
    .click();
  await fillOwnedHttpCredential(
    page.getByRole('dialog').getByLabel('Current password'),
    password,
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Continue', exact: true })
    .click();
  await expect(
    page.getByRole('img', { name: /Scan this QR code/u }),
  ).toBeVisible();
  let secret: string;
  try {
    secret = await page.getByRole('dialog').locator('code').innerText();
  } catch {
    throw new Error('Owned enrollment key could not be read');
  }
  // Review J6a final P2: a mistyped code from someone still signed in is the
  // form's own error on the real API, never a paused "Your session ended".
  const refusals: number[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/two-factor/verify-totp'))
      refusals.push(response.status());
  });
  await fillOwnedHttpCredential(
    page.getByLabel('Authenticator code', { exact: true }),
    '000000',
  );
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(
    page.getByRole('dialog').getByText('That code wasn’t accepted.', {
      exact: false,
    }),
  ).toBeVisible();
  expect(refusals).toEqual([401]);
  await expect(
    page.getByRole('heading', { name: 'Your session ended', exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get('/v1/users/me')).status()).toBe(200);
  await page.setViewportSize({ width: 375, height: 800 });
  await fillOwnedHttpCredential(
    page.getByLabel('Authenticator code', { exact: true }),
    totp(secret),
  );
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(
    page.getByRole('list', { name: 'Recovery codes' }),
  ).toBeVisible();
  let codes: string[];
  try {
    codes = await page
      .getByRole('list', { name: 'Recovery codes' })
      .getByRole('listitem')
      .allTextContents();
  } catch {
    throw new Error('Owned recovery codes could not be read');
  }
  const recoveryCode = codes[0];
  if (recoveryCode === undefined)
    throw new Error('Owned recovery code missing');
  await expect(
    page.getByRole('button', { name: 'Done', exact: true }),
  ).toBeDisabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .txt' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('pertexo-recovery-codes.txt');
  await file.delete();
  await page.getByRole('checkbox', { name: 'I’ve saved these codes' }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    page.getByText('On · 10 recovery codes remaining'),
  ).toBeVisible();
  await mkdir(temporaryTestPath('pertexo-two-factor-screenshots'), {
    recursive: true,
  });
  await page.screenshot({
    path: temporaryTestPath('pertexo-two-factor-screenshots/account-375.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width, height: 800 });
  await page.screenshot({
    path: temporaryTestPath(
      `pertexo-two-factor-screenshots/account-${String(width)}.png`,
    ),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await signOut(page);
  await signIn(page, email);
  await expect(
    page.getByLabel('Authenticator code', { exact: true }),
  ).toHaveAttribute('inputmode', 'numeric');
  await page.screenshot({
    path: temporaryTestPath(
      `pertexo-two-factor-screenshots/challenge-${String(width)}.png`,
    ),
    fullPage: true,
  });
  await fillOwnedHttpCredential(
    page.getByLabel('Authenticator code', { exact: true }),
    totp(secret),
  );
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page).toHaveURL('/workspaces');
  await page.setViewportSize({ width: 375, height: 800 });
  await signOut(page);
  await signIn(page, email);
  await page.screenshot({
    path: temporaryTestPath('pertexo-two-factor-screenshots/challenge-375.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Use a recovery code instead' })
    .click();
  await fillOwnedHttpCredential(
    page.getByLabel('Recovery code', { exact: true }),
    recoveryCode,
  );
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page).toHaveURL('/workspaces');
  await page.goto('/account/security');
  await page.getByRole('tab', { name: 'Sign-in & security' }).click();
  // The spent code is gone from the count. Refusing it again is pinned by
  // the API's integration tests; a second sign-in here would spend the
  // identity budget (10 a minute per address, sign-ups, sign-ins, enable
  // and every code check alike) that the wrong-code check above uses.
  await expect(page.getByText('On · 9 recovery codes remaining')).toBeVisible();
});
