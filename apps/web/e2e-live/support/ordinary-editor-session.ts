import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { openVerificationLink } from './verification-navigation';

const password = 'a long enough integration password';

// Sign-up's mail goes through the worker, which a busy runner can take longer than
// expect.poll's default 5 s to reach.
const VERIFICATION_MAIL_WAIT = { timeout: 30_000 };

/** Ordinary public UI authentication; no session/cookie seeding. */
export async function signInEditorUser(
  page: Page,
  email: string,
  expectedLanding = '/workspaces',
) {
  await page.goto('/login');
  await submitSignInForm(page, email);
  await expect(page).toHaveURL(expectedLanding);
}

/** Fills the sign-in form already on screen, such as the tab "Sign in again" opens. */
export async function submitSignInForm(page: Page, email: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

export async function registerEditorUser(
  page: Page,
  request: APIRequestContext,
  mailOrigin: string,
  name: string,
) {
  const email = await createVerifiedEditorUser(page, request, mailOrigin, name);
  await signInEditorUser(page, email);
  return email;
}

/**
 * Signs up and verifies an account without signing it in, for a journey that
 * needs a second person and must stay inside the sign-in rate budget.
 */
export async function createVerifiedEditorUser(
  page: Page,
  request: APIRequestContext,
  mailOrigin: string,
  name: string,
) {
  const email = `editor-${randomUUID()}@integration.test`;
  await page.goto('/sign-up');
  await page.getByLabel('Your name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  let verificationPath: string | undefined;
  await expect
    .poll(async () => {
      const response = await request.get(
        `${mailOrigin}/verification?email=${encodeURIComponent(email)}`,
      );
      if (response.ok()) {
        const body: unknown = await response.json();
        if (
          typeof body !== 'object' ||
          body === null ||
          !('path' in body) ||
          typeof body.path !== 'string'
        )
          throw new Error('Verification mail response is invalid');
        verificationPath = body.path;
      }
      return verificationPath !== undefined;
    }, VERIFICATION_MAIL_WAIT)
    .toBe(true);
  if (verificationPath === undefined)
    throw new Error('Verification mail was not delivered');
  await openVerificationLink(page, verificationPath);
  return email;
}

/** The same first-workspace form used by every ordinary newly verified user. */
export async function createEditorWorkspace(page: Page, name: string) {
  await page.getByLabel('Workspace name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Edit handle', exact: true }).click();
  await page
    .getByLabel('Handle', { exact: true })
    .fill(`live-${randomUUID().slice(0, 8)}`);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .last()
    .click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  const workspaceId = new URL(page.url()).pathname.split('/')[2];
  if (workspaceId === undefined)
    throw new Error('Workspace URL has no identifier');
  return workspaceId;
}
