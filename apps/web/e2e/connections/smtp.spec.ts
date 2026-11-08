import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import {
  connectionId,
  csrfToken,
  installRoutes,
  secretVersionId,
  timestamp,
  workspaceId,
} from './fixture';

type ProbeOutcome = Readonly<{
  ok: boolean;
  httpStatus: number | null;
  errorCode: string | null;
}>;

for (const width of [375, 1280]) {
  test(`configures and tests SMTP without sending mail at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    const tests = await openSmtpWizard(page, context, testInfo, width, {
      ok: true,
      httpStatus: 200,
      errorCode: null,
    });
    const form = page.getByRole('dialog');
    await fillServer(page);
    await form.getByRole('radio', { name: 'None', exact: true }).click();
    await expect(
      form.getByText(/Credentials and email travel without encryption/u),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`smtp-config-${String(width)}.png`),
      fullPage: true,
    });
    await form.getByRole('radio', { name: 'STARTTLS required' }).click();
    await saveAndTest(page);
    await expect(form.getByText('SMTP connection works.')).toBeVisible();
    expect(tests()).toBe(1);
    await expect(
      form.getByRole('checkbox', { name: 'Send a real test email' }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`smtp-tested-${String(width)}.png`),
      fullPage: true,
    });
  });

  test(`shows a missing host and a failed SMTP test in full at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    const tests = await openSmtpWizard(page, context, testInfo, width, {
      ok: false,
      httpStatus: null,
      errorCode: 'connection.smtp_tls',
    });
    const form = page.getByRole('dialog');
    await form.getByRole('button', { name: 'Continue' }).click();
    const host = form.getByLabel('SMTP host');
    await expect(host).toHaveAttribute('aria-invalid', 'true');
    await expect(host).toBeFocused();
    await expectNoHorizontalOverflow(page);

    await fillServer(page);
    await form.getByRole('radio', { name: 'STARTTLS required' }).click();
    await saveAndTest(page);
    await expect(form.getByText('TLS failed.', { exact: true })).toBeVisible();
    await expect(
      form.getByText(
        'Check the security mode, certificate and operator plaintext policy.',
      ),
    ).toBeVisible();
    await expect(form.getByText('SMTP connection works.')).toHaveCount(0);
    expect(tests()).toBe(1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`smtp-failed-${String(width)}.png`),
      fullPage: true,
    });
  });
}

async function openSmtpWizard(
  page: Page,
  context: BrowserContext,
  testInfo: TestInfo,
  width: number,
  outcome: ProbeOutcome,
): Promise<() => number> {
  await page.setViewportSize({ width, height: 900 });
  const origin = testInfo.project.use.baseURL;
  if (origin === undefined)
    throw new Error('Browser fixture needs its isolated origin');
  await context.addCookies([
    { name: 'pertexo_csrf', value: csrfToken, url: origin },
  ]);
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installRoutes(page);
  const saved = {
    id: connectionId,
    workspaceId,
    providerKey: 'email',
    authType: 'smtp',
    name: 'Workspace SMTP',
    status: 'active',
    secretVersionId,
    health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections`,
    async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        providerKey: 'email',
        credential: {
          type: 'smtp',
          host: 'relay.example.test',
          port: 587,
          security: 'starttls',
          username: 'ada',
          password: 'smtp-browser-fixture-password',
          fromEmail: 'alerts@example.test',
        },
      });
      await route.fulfill({ status: 201, json: saved });
    },
  );
  let tests = 0;
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}/test`,
    async (route) => {
      tests += 1;
      expect(route.request().postDataJSON()).toEqual({
        providerKey: 'email',
        transport: 'smtp',
      });
      await route.fulfill({ json: { connection: saved, outcome } });
    },
  );
  await page.goto(`/w/${workspaceId}/connections?add=any`);
  const form = page.getByRole('dialog');
  await form.getByRole('button', { name: 'Connect Email (SMTP)' }).click();
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form.getByLabel('SMTP host')).toBeFocused();
  return () => tests;
}

async function fillServer(page: Page) {
  const form = page.getByRole('dialog');
  await form.getByLabel('SMTP host').fill('relay.example.test');
  await form.getByLabel('Username').fill('ada');
  await form.getByLabel('Password').fill('smtp-browser-fixture-password');
  await form.getByLabel('From address').fill('alerts@example.test');
}

async function saveAndTest(page: Page) {
  const form = page.getByRole('dialog');
  await form.getByRole('button', { name: 'Continue' }).click();
  await form.getByLabel('Connection name').fill('Workspace SMTP');
  await form.getByRole('button', { name: 'Save and test' }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
}
