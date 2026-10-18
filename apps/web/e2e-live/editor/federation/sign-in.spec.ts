import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';

async function providerSignIn(page: Page, provider: string, email: string) {
  await page
    .getByRole('button', { name: `Continue with ${provider}`, exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Local identity provider' }),
  ).toBeVisible();
  await page.getByLabel('Provider email').fill(email);
  await page.getByRole('button', { name: 'Verify identity' }).click();
  if (provider === 'Apple')
    await page
      .getByRole('button', { name: 'Continue to Pertexo', exact: true })
      .click();
  await expect(page).toHaveURL('/workspaces');
}

for (const width of [1280, 375]) {
  test(`verified Google email retains the existing account at ${String(width)}px`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
    if (mailOrigin === undefined) throw new Error('Mail owner missing');
    await page.setViewportSize({ width, height: 800 });
    const email = await registerEditorUser(
      page,
      request,
      mailOrigin,
      'Social owner',
    );
    const workspaceId = await createEditorWorkspace(
      page,
      `Federated ${String(width)}`,
    );
    await page.goto('/workspaces');
    await page
      .getByRole('button', { name: 'Account menu for Social owner' })
      .click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL('/login');
    await mkdir('/tmp/pertexo-federation-screenshots', { recursive: true });
    await page.screenshot({
      path: `/tmp/pertexo-federation-screenshots/login-${String(width)}.png`,
      fullPage: true,
    });
    await providerSignIn(page, 'Google', email);
    await page.goto(`/w/${workspaceId}/account`);
    await page
      .getByRole('tab', { name: 'Sign-in & security', exact: true })
      .click();
    const methods = page.getByRole('list', { name: 'Sign-in methods' });
    await expect(methods.getByText('Google', { exact: true })).toBeVisible();
    await expect(methods.getByText('Password', { exact: true })).toBeVisible();
    await page.screenshot({
      path: `/tmp/pertexo-federation-screenshots/linked-${String(width)}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test(`verified GitHub creates an ordinary account at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/login');
    await providerSignIn(
      page,
      'GitHub',
      `github-${randomUUID()}@integration.test`,
    );
    await createEditorWorkspace(page, `GitHub ${String(width)}`);
    await page.goto('/account/security');
    await page
      .getByRole('tab', { name: 'Sign-in & security', exact: true })
      .click();
    const methods = page.getByRole('list', { name: 'Sign-in methods' });
    await expect(methods.getByText('GitHub', { exact: true })).toBeVisible();
    await expect(methods.getByText('Password', { exact: true })).toHaveCount(0);
    await expect(
      methods.getByText('Your only way to sign in', { exact: true }),
    ).toBeVisible();
  });
  test(`Apple form POST retains the Lax browser binding at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/login');
    await providerSignIn(
      page,
      'Apple',
      `apple-${randomUUID()}@integration.test`,
    );
    await createEditorWorkspace(page, `Apple ${String(width)}`);
    await page.goto('/account/security');
    await page
      .getByRole('tab', { name: 'Sign-in & security', exact: true })
      .click();
    const methods = page.getByRole('list', { name: 'Sign-in methods' });
    await expect(methods.getByText('Apple', { exact: true })).toBeVisible();
    await expect(
      methods.getByText('Your only way to sign in', { exact: true }),
    ).toBeVisible();
  });
}
