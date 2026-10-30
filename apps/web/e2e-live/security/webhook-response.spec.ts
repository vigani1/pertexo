import { expect, type Page } from '@playwright/test';
import { test } from '../support/browser-fixture';

/*
 * A second person, signed in on the app's origin, opens links another account
 * built. The owning API test published the workflows and checked they answer.
 */
const hooks = JSON.parse(process.env.PERTEXO_SECURITY_HOOKS ?? '{}') as Record<
  string,
  string | undefined
>;
const victim = process.env.PERTEXO_SECURITY_VICTIM ?? '';
const password = 'a long enough integration password';

/** What each payload does if it runs; the owning test builds them around this. */
const STOLEN_PATH = '/v1/stolen';

const EXPECTED_TO_RUN_TODAY = [
  'xml-xhtml',
  'xml-svg',
  'xml-stylesheet',
] as const;
const INERT_TODAY = ['plain-html', 'csv-html', 'json-html'] as const;

async function openAsVictim(page: Page, path: string | undefined) {
  const reached: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === STOLEN_PATH)
      reached.push(request.url());
  });
  const signedIn = await page.request.post('/v1/auth/sign-in/email', {
    headers: { origin: process.env.PERTEXO_LIVE_WEB_ORIGIN ?? '' },
    data: { email: victim, password, callbackURL: '/workspaces' },
  });
  expect(signedIn.status()).toBe(200);
  // Refused outright at publishing: there is no link to open.
  if (path === undefined) return { reached, title: '' };
  // An attachment ends the navigation with a download, which is also safe.
  await page.goto(path).catch(() => undefined);
  await page.waitForTimeout(1_500);
  return { reached, title: await page.title().catch(() => '') };
}

for (const name of EXPECTED_TO_RUN_TODAY)
  test(`a ${name} response does not run script on the app's origin`, async ({
    page,
  }) => {
    const { reached, title } = await openAsVictim(page, hooks[name]);
    expect(reached).toEqual([]);
    expect(title).not.toBe('PWNED');
  });

for (const name of INERT_TODAY)
  test(`a ${name} response does not run script on the app's origin`, async ({
    page,
  }) => {
    const { reached, title } = await openAsVictim(page, hooks[name]);
    expect(reached).toEqual([]);
    expect(title).not.toBe('PWNED');
  });
