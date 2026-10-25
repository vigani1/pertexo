import {
  botToken,
  connectionId,
  csrfToken,
  installRoutes,
  secretVersionId,
  timestamp,
  user,
  workflowId,
  workspace,
  workspaceId,
} from './connections/fixture';

import { expect, test } from './support/fixtures';

test('opens the add-connection HTTP choice with an ordinary pointer while background choices remain', async ({
  page,
}) => {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/connections`);
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  const chooser = page.getByRole('dialog', {
    name: 'Add a connection',
    exact: true,
  });
  await expect(chooser).toBeVisible();
  // Both sockets are deliberate; the command belongs to the open chooser.
  await expect(page.locator('button[aria-label="Connect HTTP"]')).toHaveCount(
    2,
  );
  const http = chooser.getByRole('button', {
    name: 'Connect HTTP',
    exact: true,
  });
  await expect
    .poll(() =>
      http.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          ),
        );
      }),
    )
    .toBe(true);
  await http.click();
  const credential = page.getByRole('dialog', {
    name: 'Connect HTTP',
    exact: true,
  });
  await expect(
    credential.getByLabel('Header 1 name', { exact: true }),
  ).toBeVisible();
  await expect(
    credential.getByLabel('Header 1 value', { exact: true }),
  ).toBeVisible();
});

test('creates a connection and exposes its safe identity to the editor picker', async ({
  context,
  page,
}) => {
  await context.addCookies([
    { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
  ]);
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/connections`);

  const navigation = page.getByRole('navigation', { name: 'Workspace' });
  await expect(
    navigation.getByRole('link', { name: 'Connections' }),
  ).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Connect Slack' }).click();
  const lens = page.locator('[data-slot="sheet-content"]');
  await lens.getByLabel('Slack bot token').fill(botToken);
  await lens.getByRole('button', { name: 'Continue' }).click();
  await lens.getByLabel('Connection name').fill('Incident Slack');
  await lens.getByRole('button', { name: 'Save and test' }).click();
  await expect(lens.getByText('Slack accepted the token.')).toBeVisible();
  await lens.getByRole('button', { name: 'Done' }).click();
  await expect(
    page.getByRole('button', { name: /Incident Slack, Healthy/u }),
  ).toBeVisible();
  await expect(page.getByText(botToken)).toHaveCount(0);

  await navigation.getByRole('link', { name: 'Workflows' }).click();
  await page.getByRole('link', { name: 'Slack incident alert' }).click();
  await page.getByTestId('rf__node-slack-node').click();
  const slot = page.getByRole('combobox', { name: 'Slack connection' });
  await expect(slot).toHaveText('Choose a connection');
  await slot.click();
  await expect(
    page.getByRole('option', { name: 'Incident Slack' }),
  ).toHaveCount(1);
});

test('recovers run-rejected health, pages published usage, rotates to unknown and revokes without exposing credentials', async ({
  context,
  page,
}) => {
  const nextToken = 'xoxb-1234567890-browser-rotated';
  let currentSecretVersionId = secretVersionId;
  let status: 'active' | 'revoked' | 'reauthorization_required' =
    'reauthorization_required';
  let lastTestedAt: string | null = null;
  function lastHealthTransitionSource() {
    if (currentSecretVersionId !== secretVersionId) return 'rotation';
    return lastTestedAt === null ? 'run' : 'test';
  }
  const currentConnection = () => ({
    id: connectionId,
    workspaceId,
    providerKey: 'slack',
    name: 'Incident Slack',
    authType: 'slack_bot_token',
    status,
    secretVersionId: currentSecretVersionId,
    health: {
      lastTestedAt,
      lastHealthyAt: lastTestedAt,
      lastErrorCode:
        status === 'reauthorization_required'
          ? 'connection.slack_token_revoked'
          : null,
      lastRunObservedAt: timestamp,
      lastHealthTransitionAt: timestamp,
      lastHealthTransitionSource: lastHealthTransitionSource(),
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await context.addCookies([
    { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
  ]);
  await page.route('**/v1/users/me', (route) => route.fulfill({ json: user }));
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({ json: { items: [workspace], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({
      json: { items: [currentConnection()], nextCursor: null },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}/usage?**`,
    (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('limit')).toBe('50');
      const historical = url.searchParams.has('after');
      return route.fulfill({
        json: {
          items: [
            {
              workflowId,
              workflowName: 'Incident workflow',
              workflowLifecycleStatus: historical ? 'archived' : 'active',
              workflowVersionId: historical
                ? '11111111-1111-4111-8111-111111111111'
                : '22222222-2222-4222-8222-222222222222',
              versionNumber: historical ? 1 : 2,
              isCurrentPublication: !historical,
              operationKeys: ['slack.send_message'],
            },
          ],
          nextCursor: historical ? null : 'older-page',
        },
      });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}/test`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      expect(route.request().postDataJSON()).toEqual({ providerKey: 'slack' });
      lastTestedAt = '2026-09-15T11:00:00.000Z';
      status = 'active';
      await route.fulfill({
        json: {
          connection: currentConnection(),
          outcome: { ok: true, httpStatus: 200, errorCode: null },
        },
      });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}/secret`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      expect(route.request().postDataJSON()).toEqual({
        expectedSecretVersionId: secretVersionId,
        credential: {
          type: 'slack_bot_token',
          botToken: nextToken,
        },
      });
      currentSecretVersionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      lastTestedAt = null;
      await route.fulfill({ json: currentConnection() });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: currentConnection() });
        return;
      }
      expect(route.request().method()).toBe('DELETE');
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      status = 'revoked';
      await route.fulfill({ json: currentConnection() });
    },
  );

  await page.goto(`/w/${workspaceId}/connections`);
  await page
    .getByRole('button', { name: /Incident Slack, Needs reauthorization/u })
    .focus();
  await page.keyboard.press('Enter');
  const lens = page.locator('[data-slot="sheet-content"]');
  await expect(
    lens.getByText('run credential rejected · Slack token revoked'),
  ).toBeVisible();
  await expect(
    lens.getByText('Last tested').locator('xpath=following-sibling::dd[1]'),
  ).toHaveText('Never');
  await expect(lens.getByText('Live as version 2')).toBeVisible();
  await lens.getByRole('button', { name: 'Load more' }).click();
  await expect(
    lens.getByText(
      'Live as version 2, 1 older version still used by runs (archived workflow)',
    ),
  ).toBeVisible();
  await page.screenshot({ path: '/tmp/pertexo-connection-health-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(lens).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: '/tmp/pertexo-connection-health-mobile.png' });
  await lens.getByRole('button', { name: 'Test' }).click();
  await lens.getByRole('button', { name: 'Test connection' }).click();
  await expect(lens.getByText('Slack accepted the token.')).toBeVisible();
  await lens.getByRole('button', { name: 'Back to details' }).click();
  await expect(lens.getByText('Healthy', { exact: true })).toBeVisible();
  await lens.getByRole('button', { name: 'Replace credential' }).click();
  await lens.getByLabel('Slack bot token').fill(nextToken);
  await lens.getByRole('button', { name: 'Replace credential' }).click();
  await expect(
    page.getByText('Replaced the bot token for Incident Slack'),
  ).toBeVisible();
  await expect(page.getByText(nextToken)).toHaveCount(0);
  await expect(lens.getByText('Unknown', { exact: true })).toBeVisible();
  await lens.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Revoke connection' }).click();
  await expect(page.getByText('Revoked Incident Slack')).toBeVisible();
  await expect(lens.getByText('Revoked', { exact: true })).toBeVisible();
});
