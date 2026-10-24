import {
  provisionDirectory,
  reviewProvisionedMembership,
  deactivateAndRevokeDirectory,
} from './provision-directory';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { samlMetadataSchema } from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
  signInEditorUser,
} from '../../support/ordinary-editor-session';

// Only these owned app/IdP listeners use ephemeral self-signed certificates.
test.use({
  ignoreHTTPSErrors: true,
  reducedMotion: 'reduce',
  actionTimeout: 15_000,
});
for (const width of [1280, 375]) {
  test(`configures and uses signed cross-site SAML at ${String(width)}px`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const control = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
    if (control === undefined) throw new Error('Owned control missing');
    const provider: unknown = await (
      await request.get(`${control}/provider`)
    ).json();
    if (
      typeof provider !== 'object' ||
      provider === null ||
      !('issuer' in provider) ||
      typeof provider.issuer !== 'string' ||
      !('signInUrl' in provider) ||
      typeof provider.signInUrl !== 'string' ||
      !('certificate' in provider) ||
      typeof provider.certificate !== 'string'
    )
      throw new Error('Owned SAML configuration missing');
    const domain = `${randomUUID()}.integration.test`;
    await page.setViewportSize({ width, height: 800 });
    const ownerEmail = await registerEditorUser(
      page,
      request,
      control,
      'SAML owner',
    );
    const workspaceId = await createEditorWorkspace(
      page,
      `SAML ${String(width)}`,
    );
    await page.goto(`/w/${workspaceId}/settings/sso`);
    await page
      .getByLabel('Organization name', { exact: true })
      .fill('Owned SAML organization');
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
    await page.getByText('SAML setup and metadata', { exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download SP metadata', exact: true })
      .click();
    const download = await downloaded,
      path = await download.path();
    const metadata = samlMetadataSchema.parse(
      await (
        await page.request.get(
          `/v1/workspaces/${workspaceId}/sso/saml/metadata`,
        )
      ).json(),
    );
    const xml = await readFile(path, 'utf8');
    expect(xml).toContain(metadata.entityId);
    expect(xml).toContain(metadata.redirectUri);
    expect(
      (
        await request.post(`${control}/metadata`, {
          data: { ...metadata, xml },
        })
      ).status(),
    ).toBe(204);
    await page
      .getByRole('button', { name: 'Add SAML provider', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('Provider name', { exact: true })
      .fill('Owned SAML');
    await dialog
      .getByLabel('IdP entity ID', { exact: true })
      .fill(provider.issuer);
    await dialog
      .getByLabel('SSO sign-in URL', { exact: true })
      .fill(provider.signInUrl);
    await dialog
      .getByLabel('Signing certificate', { exact: true })
      .fill(provider.certificate);
    await dialog
      .getByRole('checkbox', { name: 'Allow sign-in', exact: true })
      .check();
    await dialog
      .getByRole('button', { name: 'Save provider', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Test sign-in', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Local SAML provider' }),
    ).toBeVisible();
    await page
      .getByLabel('Organization email', { exact: true })
      .fill(`tester@${domain}`);
    await page
      .getByRole('button', { name: 'Verify SAML identity', exact: true })
      .click();
    await expect(page).toHaveURL(
      `/w/${workspaceId}/settings/sso?ssoTest=passed`,
    );
    await expect(page.getByText(/Provider test completed/u)).toBeVisible();
    await page
      .getByRole('button', { name: 'Require SSO', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Require SSO', exact: true })
      .click();
    await expect(page.getByText('SSO required', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByText('SAML setup and metadata', { exact: true }).click();
    await mkdir('/tmp/pertexo-saml-screenshots', { recursive: true });
    await page.screenshot({
      path: `/tmp/pertexo-saml-screenshots/settings-${String(width)}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const directory = await provisionDirectory({
      page,
      request,
      workspaceId,
      email: `member@${domain}`,
      width,
    });
    await page.goto('/workspaces');
    await page
      .getByRole('button', { name: 'Account menu for SAML owner' })
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
      .getByRole('button', { name: 'Continue with Owned SAML', exact: true })
      .click();
    await page
      .getByLabel('Organization email', { exact: true })
      .fill(`member@${domain}`);
    await page
      .getByRole('button', { name: 'Verify SAML identity', exact: true })
      .click();
    await expect(page).toHaveURL('/workspaces');
    await expect(
      page.getByText(`SAML ${String(width)}`, { exact: true }),
    ).toBeVisible();
    await page.goto('/account/security');
    await page
      .getByRole('tab', { name: 'Sign-in & security', exact: true })
      .click();
    await expect(
      page
        .getByRole('list', { name: 'Sign-in methods' })
        .getByText('Owned SAML', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/pertexo-saml-screenshots/account-${String(width)}.png`,
      fullPage: true,
    });
    await page.goto('/workspaces');
    await page.getByRole('button', { name: /^Account menu for /u }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL('/login');
    await signInEditorUser(page, ownerEmail, `/w/${workspaceId}`);
    await reviewProvisionedMembership(
      page,
      workspaceId,
      `member@${domain}`,
      width,
    );
    await deactivateAndRevokeDirectory(page, request, directory);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
