import {
  connectionId,
  csrfToken,
  installRoutes,
  secretVersionId,
  timestamp,
  workspaceId,
} from './fixture';

import { expect, test, type Page } from '../support/fixtures';

// A missing screen is a failure at once, not a timeout, which test.fail wouldn't accept.
test.use({ actionTimeout: 5_000 });

const settings = {
  grantType: 'authorization_code',
  authorizationUrl: 'https://id.example.test/authorize',
  authorizationParameters: {},
  pkce: 's256',
  tokenUrl: 'https://token.example.test/token',
  clientId: 'pertexo-client',
  scope: 'read',
  clientAuthentication: 'basic',
  tokenParameters: {},
  requestHosts: { mode: 'any' },
};

const connection = (status: string, extra: Record<string, unknown> = {}) => ({
  id: connectionId,
  workspaceId,
  providerKey: 'http',
  name: 'Billing API',
  authType: 'oauth2',
  status,
  secretVersionId,
  health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
  createdAt: timestamp,
  updatedAt: timestamp,
  oauth2: {
    settings,
    redirectUri: 'http://127.0.0.1:4173/v1/connections/oauth2/callback',
  },
  ...extra,
});

async function showConnection(page: Page, body: unknown): Promise<void> {
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await installRoutes(page);
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({ json: { items: [body], nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    (route) => route.fulfill({ json: body }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}/usage**`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto(`/w/${workspaceId}/connections?connection=${connectionId}`);
}

const lens = (page: Page) => page.locator('[data-slot="sheet-content"]');

// Detail, active facts: one sentence per kind of grant.
for (const [name, grant, text] of [
  [
    'renewable',
    {
      authorizedAt: timestamp,
      accessTokenExpiresAt: timestamp,
      renewable: true,
    },
    'Token renews automatically',
  ],
  [
    'with an expiry',
    {
      authorizedAt: timestamp,
      accessTokenExpiresAt: timestamp,
      renewable: false,
    },
    /^Token expires .+; someone will need to reconnect$/u,
  ],
  [
    'with no expiry',
    { authorizedAt: timestamp, accessTokenExpiresAt: null, renewable: false },
    'The service gave no expiry',
  ],
] as const)
  test.fail(`detail: an active grant ${name} says so`, async ({ page }) => {
    await showConnection(page, connection('active', { grant }));
    await expect(lens(page).getByText(text)).toBeVisible();
    await expect(
      lens(page).getByRole('button', { name: 'Reconnect', exact: true }),
    ).toBeVisible();
    await expect(
      lens(page).getByRole('button', { name: 'Edit settings', exact: true }),
    ).toBeVisible();
  });

// Detail, notice table: each code's notice and its short form on the list.
for (const [code, notice, short, button] of [
  [
    'connection.oauth2_not_authorized',
    'Not connected yet. Connect to sign in at id.example.test.',
    'not connected yet',
    'Connect',
  ],
  [
    'connection.oauth2_grant_revoked',
    "token.example.test no longer accepts this connection's sign-in. Reconnect to restore it.",
    'sign-in revoked',
    'Reconnect',
  ],
  [
    'connection.oauth2_client_rejected',
    'token.example.test refused the client ID or secret. Replace them, then connect.',
    'client refused',
    'Reconnect',
  ],
  [
    'connection.oauth2_token_expired',
    'The access token expired and this service gave no way to renew it. Reconnect.',
    'token expired',
    'Reconnect',
  ],
] as const)
  test.fail(
    `detail: ${code} shows its notice and short form`,
    async ({ page }) => {
      await showConnection(
        page,
        connection('reauthorization_required', {
          health: {
            lastTestedAt: null,
            lastHealthyAt: null,
            lastErrorCode: code,
          },
        }),
      );
      await expect(
        lens(page).getByText('Needs reauthorization', { exact: true }),
      ).toBeVisible();
      await expect(lens(page).getByText(notice, { exact: true })).toBeVisible();
      await expect(
        lens(page).getByRole('button', { name: button, exact: true }),
      ).toBeVisible();
      await expect(page.getByText(short)).toBeVisible();
    },
  );

// Detail: Revoke dialog adds the provider-side sentence.
test.fail('detail: revoke says what stays at the service', async ({ page }) => {
  await showConnection(
    page,
    connection('active', {
      grant: {
        authorizedAt: timestamp,
        accessTokenExpiresAt: null,
        renewable: false,
      },
    }),
  );
  await lens(page).getByRole('button', { name: 'Revoke' }).click();
  await expect(
    page.getByText(
      'Pertexo deletes its tokens. To remove access at token.example.test, revoke it there too.',
    ),
  ).toBeVisible();
});

// Edit settings: all fields prefilled except the secret, which must be typed again (S22).
test.fail(
  'edit settings prefills everything but the secret',
  async ({ page }) => {
    await showConnection(
      page,
      connection('active', {
        grant: {
          authorizedAt: timestamp,
          accessTokenExpiresAt: null,
          renewable: false,
        },
      }),
    );
    await lens(page).getByRole('button', { name: 'Edit settings' }).click();
    await expect(
      lens(page).getByLabel('Client ID', { exact: true }),
    ).toHaveValue('pertexo-client');
    await expect(
      lens(page).getByLabel('Token URL', { exact: true }),
    ).toHaveValue(settings.tokenUrl);
    await expect(
      lens(page).getByLabel('Client secret', { exact: true }),
    ).toHaveValue('');
  },
);

// Connection tests table: the copy for an API that refuses the token.
test.fail('test: an API refusal says what to check', async ({ page }) => {
  const active = connection('active', {
    grant: {
      authorizedAt: timestamp,
      accessTokenExpiresAt: null,
      renewable: false,
    },
  });
  await showConnection(page, active);
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}/test`,
    (route) =>
      route.fulfill({
        json: {
          connection: active,
          outcome: {
            ok: false,
            httpStatus: 401,
            errorCode: 'connection.credential_rejected',
          },
        },
      }),
  );
  await lens(page).getByRole('button', { name: 'Test', exact: true }).click();
  await lens(page)
    .getByLabel('Address to call')
    .fill('https://billing.example.test/me');
  await lens(page).getByRole('button', { name: 'Call this address' }).click();
  await expect(
    lens(page).getByText('The API refused this token.'),
  ).toBeVisible();
  await expect(
    lens(page).getByText(
      'It answered 401 or 403. Check the scope and that this account can reach that URL, or reconnect.',
    ),
  ).toBeVisible();
  await expect(
    lens(page).getByText('Needs reauthorization', { exact: true }),
  ).toHaveCount(0);
});

// Create form: the sign-in types and the Advanced help text.
test.fail(
  'form: server to server hides what it has no use for',
  async ({ page }) => {
    await page.context().addCookies([
      {
        name: 'pertexo_csrf',
        value: csrfToken,
        url: 'http://127.0.0.1:4173',
      },
    ]);
    await installRoutes(page);
    await page.goto(`/w/${workspaceId}/connections?add=http`);
    const sheet = lens(page);
    await sheet.getByRole('radio', { name: 'OAuth2', exact: true }).click();
    await expect(
      sheet.getByLabel('Authorization URL', { exact: true }),
    ).toBeVisible();
    await sheet.getByText('Advanced', { exact: true }).click();
    await expect(sheet.getByLabel('PKCE')).toBeVisible();
    await expect(
      sheet
        .getByText(
          "Don't put secrets here; people who can see this connection can read them.",
        )
        .first(),
    ).toBeVisible();
    await sheet
      .getByRole('radio', { name: 'Server to server', exact: true })
      .click();
    await expect(
      sheet.getByLabel('Authorization URL', { exact: true }),
    ).toHaveCount(0);
    await expect(sheet.getByLabel('PKCE')).toHaveCount(0);
    await expect(
      sheet.getByLabel('Extra authorization parameters'),
    ).toHaveCount(0);
    await expect(sheet.getByLabel('Token URL', { exact: true })).toBeVisible();
  },
);

// Connect step, for server to server: only one host is named.
test.fail(
  'form: server to server names only the token host',
  async ({ page }) => {
    await page.context().addCookies([
      {
        name: 'pertexo_csrf',
        value: csrfToken,
        url: 'http://127.0.0.1:4173',
      },
    ]);
    await installRoutes(page);
    await page.route(`**/v1/workspaces/${workspaceId}/connections`, (route) =>
      route.fulfill({
        status: 201,
        json: connection('reauthorization_required'),
      }),
    );
    await page.goto(`/w/${workspaceId}/connections?add=http`);
    const sheet = lens(page);
    await sheet.getByRole('radio', { name: 'OAuth2', exact: true }).click();
    await sheet
      .getByRole('radio', { name: 'Server to server', exact: true })
      .click();
    await sheet
      .getByLabel('Token URL', { exact: true })
      .fill('https://token.example.test/token');
    await sheet.getByLabel('Client ID', { exact: true }).fill('pertexo-client');
    await sheet.getByLabel('Client secret', { exact: true }).fill('a-secret');
    await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
    await sheet
      .getByLabel('Connection name', { exact: true })
      .fill('Billing API');
    await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      sheet.getByText('Pertexo gets its token from token.example.test.'),
    ).toBeVisible();
  },
);
