import { expect, test } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const destinationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const csrfToken = 'csrf-token-for-notification-tests-123456789012345678';
const timestamp = '2026-09-15T10:00:00.000Z';

test('creates, versions and disables a notification destination', async ({
  context,
  page,
}) => {
  let destination:
    | {
        id: string;
        workspaceId: string;
        kind: 'slack';
        status: 'enabled' | 'disabled';
        currentVersion: number;
        config: { kind: 'slack'; connectionId: string; channelId: string };
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  const workspace = {
    id: workspaceId,
    name: 'Control Operations',
    slug: 'control-operations',
    status: 'active',
    revision: 1,
    role: 'owner',
    capabilities: [
      'workspace:read',
      'workflow:update',
      'connection:read',
      'connection:manage',
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const connection = {
    id: connectionId,
    workspaceId,
    providerKey: 'slack',
    name: 'Incident Slack',
    authType: 'slack_bot_token',
    status: 'active',
    secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await context.addCookies([
    { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
  ]);
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      json: {
        id: userId,
        email: 'owner@example.test',
        displayName: 'Workspace Owner',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }),
  );
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({ json: { items: [workspace], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({ json: { items: [connection], nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/failure-notification-destinations`,
    async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          json: { items: destination ? [destination] : [] },
        });
        return;
      }
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      expect(route.request().postDataJSON()).toEqual({
        kind: 'slack',
        connectionId,
        channelId: 'C0123456789',
      });
      destination = {
        id: destinationId,
        workspaceId,
        kind: 'slack',
        status: 'enabled',
        currentVersion: 1,
        config: {
          kind: 'slack',
          connectionId,
          channelId: 'C0123456789',
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await route.fulfill({ status: 201, json: destination });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/versions`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: 1,
        config: {
          kind: 'slack',
          connectionId,
          channelId: 'C9876543210',
        },
      });
      if (destination === undefined)
        throw new Error('The destination must be created before versioning.');
      destination = {
        ...destination,
        currentVersion: 2,
        config: { kind: 'slack', connectionId, channelId: 'C9876543210' },
      };
      await route.fulfill({ json: destination });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/status`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({ status: 'disabled' });
      if (destination === undefined)
        throw new Error('The destination must be created before disabling.');
      destination = { ...destination, status: 'disabled' };
      await route.fulfill({ json: destination });
    },
  );

  await page.goto(`/w/${workspaceId}/alerts`);
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'Alerts' }),
  ).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Add destination' }).click();
  const lens = page.locator('[data-slot="sheet-content"]');
  await lens.getByLabel('Slack connection').click();
  await page.getByRole('option', { name: 'Incident Slack' }).click();
  await lens.getByLabel('Channel ID').fill('C0123456789');
  await lens.getByRole('button', { name: 'Add destination' }).click();
  await expect(page.getByText('#C0123456789 via Incident Slack')).toBeVisible();

  await page.getByRole('button', { name: /^Edit #C0123456789/u }).click();
  await expect(
    lens.getByText(/Version 1 · saving creates version 2/u),
  ).toBeAttached();
  await lens.getByLabel('Channel ID').fill('C9876543210');
  await lens.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('#C9876543210 via Incident Slack')).toBeVisible();

  const toggle = page.getByRole('switch', {
    name: 'Send alerts to #C9876543210 via Incident Slack',
  });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByText('Alerts to #C9876543210 via Incident Slack turned off'),
  ).toBeVisible();
});
