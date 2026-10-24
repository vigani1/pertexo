import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../test/support/fixtures/identity';
import { expect, test, type Page } from '../support/fixtures';
import { API_TOKEN_SCOPES, type ApiTokenMetadata } from '@pertexo/contracts';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tokenId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const timestamp = '2026-10-14T10:00:00.000Z';
const credential = `ptx_1.${workspaceId}.${tokenId}.${'A'.repeat(43)}`;
const csrf = 'csrf-token-for-api-token-browser-tests-1234567890123456789';
const path = `/w/${workspaceId}/settings/api-tokens`;
const initialToken: ApiTokenMetadata = {
  id: tokenId,
  workspaceId,
  name: 'Build runner',
  scopes: ['run:read', 'workflow:read'],
  status: 'active',
  createdAt: timestamp,
  expiresAt: '2026-11-13T10:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
};

async function install(
  page: Page,
  enabled = true,
  initial: ApiTokenMetadata[] = [],
) {
  let items = initial;
  const creates: { key: string | undefined; body: unknown }[] = [];
  const revokes: (string | undefined)[] = [];
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrf, url: 'http://127.0.0.1:4173' },
    ]);
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      json: createUserFixture({
        email: 'owner@example.test',
        displayName: 'Workspace Owner',
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    }),
  );
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({
      json: {
        items: [
          createWorkspaceFixture({
            id: workspaceId,
            name: 'Automation workspace',
            slug: 'automation',
            capabilities: ['workspace:read'],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/api-tokens?**`, (route) =>
    route.fulfill({
      json: {
        enabled,
        items,
        nextCursor: null,
        availableScopes: API_TOKEN_SCOPES,
      },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/api-tokens`,
    async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      creates.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      });
      items = [initialToken];
      await route.fulfill({
        status: 201,
        json: { token: initialToken, secret: credential, replayed: false },
      });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/api-tokens/${tokenId}/revoke`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      revokes.push(route.request().headers()['idempotency-key']);
      const revoked: ApiTokenMetadata = {
        ...initialToken,
        status: 'revoked',
        revokedAt: timestamp,
      };
      items = [revoked];
      await route.fulfill({ json: { token: revoked, replayed: false } });
    },
  );
  return { creates, revokes };
}
async function create(page: Page) {
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await page.getByLabel('Token name', { exact: true }).fill('Build runner');
  const scope = page.getByRole('checkbox', {
    name: 'Read workflows',
    exact: true,
  });
  await scope.focus();
  await page.keyboard.press('Space');
  await page.getByRole('checkbox', { name: 'Read runs', exact: true }).check();
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect(
    page.getByLabel('API token secret', { exact: true }),
  ).toHaveValue(credential);
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 375, height: 768 },
]) {
  test(`creates once and revokes through token Settings at ${String(viewport.width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const requests = await install(page);
    await page.goto(path);
    await expect(
      page.getByRole('heading', { name: 'API tokens', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('No API tokens yet', { exact: true }),
    ).toBeVisible();
    await create(page);
    await expect(
      page.getByRole('button', { name: 'Done', exact: true }),
    ).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(
      page.getByLabel('API token secret', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Copy API token secret', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Copied', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      credential,
    );
    await page
      .getByRole('checkbox', { name: 'I’ve saved this token', exact: true })
      .check();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByLabel('API token secret', { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Create token', exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole('heading', { name: 'Build runner', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const screenshotDirectory = process.env.PERTEXO_TOKEN_SCREENSHOTS;
    if (screenshotDirectory !== undefined)
      await page.screenshot({
        path: `${screenshotDirectory}/settings-${viewport.width === 375 ? 'phone' : 'desktop'}.png`,
        fullPage: true,
      });
    expect(requests.creates).toHaveLength(1);
    expect(requests.creates[0]?.key).toBeTruthy();
    expect(requests.creates[0]?.body).toEqual({
      name: 'Build runner',
      scopes: ['run:read', 'workflow:read'],
      expiresInDays: 30,
    });
    await page
      .getByRole('button', { name: 'Revoke Build runner', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Revoke token', exact: true })
      .click();
    await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
    expect(requests.revokes).toHaveLength(1);
    await page.reload();
    await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
    await expect(
      page.getByLabel('API token secret', { exact: true }),
    ).toHaveCount(0);
  });
}

test('explains disabled automation and keeps existing tokens revocable', async ({
  page,
}) => {
  await install(page, false, [initialToken]);
  await page.goto(path);
  await expect(
    page.getByText(/Automation tokens are disabled on this server/u),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create token', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Revoke Build runner', exact: true })
    .click();
  await page.getByRole('button', { name: 'Revoke token', exact: true }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
});

test('bounds long names and announces each scope once on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await install(page, true, [{ ...initialToken, name: 'x'.repeat(128) }]);
  await page.goto(path);
  await expect(
    page.getByRole('heading', { name: 'x'.repeat(128), exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Read workflows', exact: true }),
  ).toHaveAccessibleDescription('List, inspect and export saved workflows.');
  await page.getByLabel('Token name', { exact: true }).fill('Phone runner');
  await page
    .getByRole('checkbox', { name: 'Resolve connection bindings', exact: true })
    .check();
  await page.getByLabel('Expires in (days)', { exact: true }).fill('365');
  await page
    .getByRole('button', { name: 'Create token', exact: true })
    .scrollIntoViewIfNeeded();
  if (process.env.PERTEXO_TOKEN_SCREENSHOTS !== undefined)
    await page.screenshot({
      path: `${process.env.PERTEXO_TOKEN_SCREENSHOTS}/create-phone.png`,
    });
  expect(
    await page
      .getByRole('dialog')
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
