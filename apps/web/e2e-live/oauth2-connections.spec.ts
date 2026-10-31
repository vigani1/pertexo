import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { test } from './support/browser-fixture';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from './support/authoring/single-step';

type Journey = Readonly<{
  standIn: string;
  password: string;
  workspaceId: string;
  owner: string;
  viewer: string;
  builder: string;
}>;

const journey = JSON.parse(
  process.env.PERTEXO_OAUTH2_JOURNEY ?? 'null',
) as Journey | null;
if (journey === null)
  throw new Error('Run through the OAuth2 journey owner in apps/worker.');
const { standIn, password, workspaceId, owner, viewer, builder } = journey;
const connectionsPath = `/w/${workspaceId}/connections`;
const webOrigin = process.env.PERTEXO_LIVE_WEB_ORIGIN ?? '';

// Each scene stops at the first missing screen, instead of waiting out its whole budget.
test.use({ actionTimeout: 10_000 });
// Scenes publish and run for real, and a shared machine's validator may ask them to wait.
test.describe.configure({ timeout: 180_000 });

const uniqueClient = (behavior: string): string =>
  `${behavior}.${crypto.randomUUID().slice(0, 12)}`;

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/u);
}

async function openOAuth2Form(page: Page): Promise<Locator> {
  await page.goto(connectionsPath);
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Add a connection', exact: true })
    .getByRole('button', { name: 'Connect HTTP', exact: true })
    .click();
  const sheet = page.getByRole('dialog', { name: 'Connect HTTP', exact: true });
  await sheet.getByRole('radio', { name: 'OAuth2', exact: true }).click();
  return sheet;
}

/** Fills the plan's form and names the connection, up to the Connect step. */
async function fillForm(
  sheet: Locator,
  clientId: string,
  name: string,
): Promise<void> {
  await sheet
    .getByLabel('Authorization URL', { exact: true })
    .fill(`${standIn}/authorize`);
  await sheet.getByLabel('Token URL', { exact: true }).fill(`${standIn}/token`);
  await sheet.getByLabel('Client ID', { exact: true }).fill(clientId);
  await sheet
    .getByLabel('Client secret', { exact: true })
    .fill('a-journey-secret');
  await sheet.getByLabel('Scope', { exact: true }).fill('read');
  await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
  await sheet.getByLabel('Connection name', { exact: true }).fill(name);
  await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
}

async function clickConnect(
  page: Page,
  scope: Locator,
  name: 'Connect' | 'Reconnect' = 'Connect',
): Promise<Page> {
  const opened = page.waitForEvent('popup');
  await scope.getByRole('button', { name, exact: true }).click();
  return opened;
}

async function closesOrSays(popup: Page, text: string): Promise<void> {
  await Promise.race([
    popup.waitForEvent('close'),
    popup.getByText(text, { exact: true }).waitFor(),
  ]);
}

async function createConnected(
  page: Page,
  behavior: string,
  name: string,
): Promise<string> {
  const clientId = uniqueClient(behavior);
  const sheet = await openOAuth2Form(page);
  await fillForm(sheet, clientId, name);
  const popup = await clickConnect(page, sheet);
  await popup.getByRole('button', { name: 'Approve', exact: true }).click();
  await closesOrSays(popup, 'Connected. You can close this tab.');
  await expect(
    sheet.getByRole('button', { name: 'Call this address', exact: true }),
  ).toBeVisible();
  await sheet.getByRole('button', { name: 'Done', exact: true }).click();
  return clientId;
}

async function publishCallTo(
  page: Page,
  connectionName: string,
  workflowName: string,
): Promise<string> {
  const path = await createEditorWorkflow(page, workspaceId, workflowName);
  await addSingleStep(page, path, /HTTP request/u, 'Call the API');
  await page.getByLabel('URL', { exact: true }).fill(`${standIn}/api`);
  await page.getByLabel('HTTP connection', { exact: true }).click();
  await page.getByRole('option', { name: connectionName, exact: true }).click();
  await publishSingleStep(page, path);
  return path;
}

async function controlCounts(
  page: Page,
  clientId: string,
): Promise<{ token: number; api: number }> {
  const response = await page.request.get(
    `${standIn}/control/requests?clientId=${encodeURIComponent(clientId)}`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as { token: number; api: number };
}

async function asRole(
  browser: Browser,
  email: string,
  scene: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ baseURL: webOrigin });
  try {
    const page = await context.newPage();
    await signIn(page, email);
    await scene(page);
  } finally {
    await context.close();
  }
}

// One sign-in, shared: the real limit is 10 a minute per address, and a quick run
// through these scenes would reach it.
let ownerCookies: Awaited<ReturnType<BrowserContext['cookies']>>;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: webOrigin });
  try {
    await signIn(await context.newPage(), owner);
    ownerCookies = await context.cookies();
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(ownerCookies);
});

// Plan journey 1 and 2: the form, both hosts, consent, and the first tab moving on by itself.
test('adds a connection and connects it with no reload', async ({ page }) => {
  const clientId = uniqueClient('non-rotating');
  const sheet = await openOAuth2Form(page);
  const redirect = sheet.getByLabel('Redirect URL', { exact: true });
  await expect(redirect).toHaveValue(
    `${webOrigin}/v1/connections/oauth2/callback`,
  );
  await expect(redirect).toHaveAttribute('readonly', /.*/u);
  await expect(
    sheet.getByText('Register this address with the service first.', {
      exact: true,
    }),
  ).toBeVisible();
  await fillForm(sheet, clientId, 'Journey API');
  const host = new URL(standIn).host;
  await expect(
    sheet.getByText(
      `You'll sign in at ${host}. Pertexo then gets its token from ${host}.`,
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { journeyMarker: boolean }).journeyMarker = true;
  });
  const popup = await clickConnect(page, sheet);
  await expect(
    sheet.getByText('Finish signing in in the window that opened.', {
      exact: true,
    }),
  ).toBeVisible();
  await popup.getByRole('button', { name: 'Approve', exact: true }).click();
  await closesOrSays(popup, 'Connected. You can close this tab.');
  await expect(
    sheet.getByRole('button', { name: 'Call this address', exact: true }),
  ).toBeVisible();
  // No reload happened: the mark set before consent is still here.
  expect(
    await page.evaluate(
      () => (window as unknown as { journeyMarker?: boolean }).journeyMarker,
    ),
  ).toBe(true);
  expect((await controlCounts(page, clientId)).token).toBe(1);
});

// Plan journey 3 and 4: run, revoke, the failure text and notice, reconnect, same workflow.
test('runs, shows a revoked grant, and reconnects without editing the workflow', async ({
  page,
}) => {
  const name = `Revoked API ${crypto.randomUUID().slice(0, 6)}`;
  // Always inside the renewal window, so the next run really asks the service.
  const clientId = await createConnected(page, 'short-lived', name);
  await publishCallTo(page, name, `Uses ${name}`);
  const workflowUrl = page.url();
  const firstRun = await startSingleStep(page, {});
  await waitForRun(page, workspaceId, firstRun, 'succeeded');
  expect((await controlCounts(page, clientId)).api).toBe(1);

  const revoked = await page.request.post(`${standIn}/control/revoke`, {
    data: { clientId },
  });
  expect(revoked.ok()).toBe(true);
  await page.goto(workflowUrl);
  const failedRun = await startSingleStep(page, {});
  await waitForRun(page, workspaceId, failedRun, 'failed');
  // A step's failure text is in its details on the run page.
  await page.getByRole('button', { name: /^Call the API: Failed/u }).click();
  await expect(
    page
      .getByRole('complementary', { name: 'Step details' })
      .getByText(
        "The service no longer accepts this connection's sign-in. Reconnect it in Connections.",
      ),
  ).toBeVisible();

  await page.goto(connectionsPath);
  await expect(page.getByText('sign-in revoked')).toBeVisible();
  await page
    .getByRole('button', { name: new RegExp(`^${name},`, 'u') })
    .click();
  const lens = page.locator('[data-slot="sheet-content"]');
  await expect(
    lens.getByText('Needs reauthorization', { exact: true }),
  ).toBeVisible();
  const host = new URL(standIn).host;
  await expect(
    lens.getByText(
      `${host} no longer accepts this connection's sign-in. Reconnect to restore it.`,
    ),
  ).toBeVisible();
  const popup = await clickConnect(page, lens, 'Reconnect');
  await popup.getByRole('button', { name: 'Approve', exact: true }).click();
  await closesOrSays(popup, 'Connected. You can close this tab.');
  await expect(lens.getByText('Healthy', { exact: true })).toBeVisible();

  await page.goto(workflowUrl);
  const restoredRun = await startSingleStep(page, {});
  await waitForRun(page, workspaceId, restoredRun, 'succeeded');
});

// Plan journey 5: Deny shows the denied text and changes nothing.
test('deny shows the text and changes nothing', async ({ page }) => {
  const sheet = await openOAuth2Form(page);
  const clientId = uniqueClient('non-rotating');
  await fillForm(sheet, clientId, `Denied ${clientId}`);
  const popup = await clickConnect(page, sheet);
  await popup.getByRole('button', { name: 'Deny', exact: true }).click();
  await closesOrSays(popup, "You didn't allow access. Nothing changed.");
  expect((await controlCounts(page, clientId)).token).toBe(0);
  await page.goto(connectionsPath);
  await expect(page.getByText('not connected yet')).toBeVisible();
});

// Plan journey 6, decision "Consent window": an unsaved draft survives consent.
test('a New HTTP sheet keeps the unsaved draft and selects the connection', async ({
  page,
}) => {
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    `Draft ${crypto.randomUUID().slice(0, 6)}`,
  );
  await addSingleStep(page, path, /HTTP request/u, 'Draft call');
  const editorUrl = page.url();
  await page
    .getByLabel('URL', { exact: true })
    .fill(`${standIn}/api?unsaved=1`);
  await page.getByRole('button', { name: /^New HTTP/u }).click();
  const sheet = page.getByRole('dialog', {
    name: 'Connect HTTP',
    exact: true,
  });
  await sheet.getByRole('radio', { name: 'OAuth2', exact: true }).click();
  const name = `From editor ${crypto.randomUUID().slice(0, 6)}`;
  await fillForm(sheet, uniqueClient('non-rotating'), name);
  const popup = await clickConnect(page, sheet);
  await popup.getByRole('button', { name: 'Approve', exact: true }).click();
  await closesOrSays(popup, 'Connected. You can close this tab.');
  await expect(
    page.getByLabel('HTTP connection', { exact: true }),
  ).toContainText(name);
  expect(page.url()).toBe(editorUrl);
  await expect(page.getByLabel('URL', { exact: true })).toHaveValue(
    `${standIn}/api?unsaved=1`,
  );
});

// Plan journey 7: a blocked window offers the link, and the link works.
test('a blocked window shows Open sign-in page, which works', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const sheet = await openOAuth2Form(page);
  const clientId = uniqueClient('non-rotating');
  await fillForm(sheet, clientId, `Blocked ${clientId}`);
  await sheet.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(
    sheet.getByText('Your browser blocked the window.', { exact: true }),
  ).toBeVisible();
  const link = sheet.getByRole('link', {
    name: 'Open sign-in page',
    exact: true,
  });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const opened = page.waitForEvent('popup');
  await link.click();
  const popup = await opened;
  await popup.getByRole('button', { name: 'Approve', exact: true }).click();
  await closesOrSays(popup, 'Connected. You can close this tab.');
  await expect(
    sheet.getByRole('button', { name: 'Call this address', exact: true }),
  ).toBeVisible();
});

// Plan journey 8, Roles table: who sees Connect and Edit settings, and who may test.
test('a viewer and a builder see no Connect or Edit settings; a builder can pick it', async ({
  page,
  browser,
}) => {
  const name = `Roles ${crypto.randomUUID().slice(0, 6)}`;
  await createConnected(page, 'non-rotating', name);
  const noManagerButtons = async (member: Page, allowTest: boolean) => {
    await member.goto(connectionsPath);
    await member
      .getByRole('button', { name: new RegExp(`^${name},`, 'u') })
      .click();
    const lens = member.locator('[data-slot="sheet-content"]');
    await expect(lens.getByText(name, { exact: true })).toBeVisible();
    for (const button of ['Connect', 'Reconnect', 'Edit settings'])
      await expect(lens.getByRole('button', { name: button })).toHaveCount(0);
    await expect(
      lens.getByRole('button', { name: 'Test', exact: true }),
    ).toHaveCount(allowTest ? 1 : 0);
  };
  await asRole(browser, viewer, (member) => noManagerButtons(member, false));
  await asRole(browser, builder, async (member) => {
    await noManagerButtons(member, true);
    await publishCallTo(member, name, `Builder uses ${name}`);
  });
});

// Plan journey 9: a phone-sized viewport for the form and the landing page.
test('the form and landing page fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 768 });
  const sheet = await openOAuth2Form(page);
  await expect(sheet.getByLabel('Token URL', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto('/connections/oauth2/finished?result=invalid');
  await expect(
    page.getByText(
      'This sign-in link is no longer valid. Start again from Connections.',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
