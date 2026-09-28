import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { openVerificationLink } from './verification-navigation';

const password = 'a long enough integration password';

/** Ordinary public UI authentication; no session/cookie seeding. */
export async function signInEditorUser(
  page: Page,
  email: string,
  expectedLanding = '/workspaces',
) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(expectedLanding);
}

export async function registerEditorUser(
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
    })
    .toBe(true);
  if (verificationPath === undefined)
    throw new Error('Verification mail was not delivered');
  await openVerificationLink(page, verificationPath);
  await signInEditorUser(page, email);
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
