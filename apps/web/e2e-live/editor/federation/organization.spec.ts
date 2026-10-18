import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';

// Only this owned HTTPS IdP has an ephemeral self-signed certificate.
test.use({ ignoreHTTPSErrors: true });
for (const width of [1280, 375]) {
  test(`configures, tests and uses organization OIDC at ${String(width)}px`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
    if (mailOrigin === undefined) throw new Error('Owned mail missing');
    const config: unknown = await (
      await request.get(`${mailOrigin}/organization-provider`)
    ).json();
    if (
      typeof config !== 'object' ||
      config === null ||
      !('issuer' in config) ||
      typeof config.issuer !== 'string'
    )
      throw new Error('Owned issuer missing');
    const domain = `${randomUUID()}.integration.test`;
    await page.setViewportSize({ width, height: 800 });
    await registerEditorUser(page, request, mailOrigin, 'Organization owner');
    const workspaceId = await createEditorWorkspace(
      page,
      `Organization ${String(width)}`,
    );
    await page.goto(`/w/${workspaceId}/settings/sso`);
    await page
      .getByLabel('Organization name', { exact: true })
      .fill('Owned organization');
    await page
      .getByRole('button', { name: 'Create organization', exact: true })
      .click();
    await page.getByLabel('Add domain', { exact: true }).fill(domain);
    await page
      .getByRole('button', { name: 'Create DNS challenge', exact: true })
      .click();
    await expect(
      page.getByText(`_pertexo.${domain}`, { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Verify DNS', exact: true }).click();
    await expect(page.getByText('Verified', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'Add OIDC provider', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('Provider name', { exact: true })
      .fill('Owned OIDC');
    await dialog.getByLabel('OIDC issuer', { exact: true }).fill(config.issuer);
    await dialog
      .getByLabel('Client ID', { exact: true })
      .fill('owned-browser-client');
    await dialog
      .getByLabel('Client secret', { exact: true })
      .fill('owned-browser-secret');
    await dialog
      .getByRole('checkbox', { name: 'Allow sign-in', exact: true })
      .check();
    await dialog
      .getByRole('checkbox', { name: 'Allow new accounts', exact: true })
      .check();
    await dialog
      .getByRole('button', { name: 'Save provider', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Test sign-in', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Local organization provider' }),
    ).toBeVisible();
    await page
      .getByLabel('Organization email', { exact: true })
      .fill(`tester@${domain}`);
    await page
      .getByRole('button', {
        name: 'Verify organization identity',
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(
      `/w/${workspaceId}/settings/sso?ssoTest=passed`,
    );
    await expect(page.getByText(/Provider test completed/u)).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Test domain', exact: true }),
    ).toContainText(domain);
    await page
      .getByRole('button', { name: 'Require SSO', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Require SSO', exact: true })
      .click();
    await expect(page.getByText('SSO required', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await mkdir('/tmp/pertexo-organization-screenshots', { recursive: true });
    await page.screenshot({
      path: `/tmp/pertexo-organization-screenshots/settings-${String(width)}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.goto('/workspaces');
    await page
      .getByRole('button', { name: 'Account menu for Organization owner' })
      .click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await page
      .getByRole('button', { name: 'Organization sign-in', exact: true })
      .click();
    await page.getByLabel('Organization domain', { exact: true }).fill(domain);
    await page
      .getByRole('button', { name: 'Find sign-in', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Continue with Owned OIDC', exact: true })
      .click();
    await page
      .getByLabel('Organization email', { exact: true })
      .fill(`member@${domain}`);
    await page
      .getByRole('button', {
        name: 'Verify organization identity',
        exact: true,
      })
      .click();
    await expect(page).toHaveURL('/workspaces');
    await expect(
      page.getByText(`Organization ${String(width)}`, { exact: true }),
    ).toBeVisible();
    await page.goto('/account/security');
    await page
      .getByRole('tab', { name: 'Sign-in & security', exact: true })
      .click();
    await expect(
      page
        .getByRole('list', { name: 'Sign-in methods' })
        .getByText('Owned OIDC', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/pertexo-organization-screenshots/account-${String(width)}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
