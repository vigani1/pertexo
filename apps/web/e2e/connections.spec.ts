import { expect, test, type Page } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const secretVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const csrfToken = 'csrf-token-for-connections-tests-123456789012345678';
const botToken = 'xoxb-1234567890-browser-secret';
const timestamp = '2026-09-15T10:00:00.000Z';
const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  role: 'owner',
  capabilities: [
    'workspace:read',
    'workflow:read',
    'workflow:update',
    'connection:read',
    'connection:use',
    'connection:manage',
  ],
  createdAt: timestamp,
  updatedAt: timestamp,
};
const workflow = {
  id: workflowId,
  workspaceId,
  name: 'Slack incident alert',
  lifecycleStatus: 'active',
  lifecycleRevision: 1,
  activationStatus: 'inactive',
  publishedVersionId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const release = {
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
};
const slackDefinition = {
  schemaVersion: 1,
  definition: { key: 'slack.send', version: 1 },
  family: 'action',
  configVersion: 1,
  configSchema: { type: 'object', properties: {} },
  inputSchema: {},
  outputSchema: {},
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: ['slack_bot_token'],
  retryClass: 'safe',
  resourceClass: 'io',
  capabilities: [],
  lifecycle: 'active',
  available: true,
  publishable: true,
};

async function installRoutes(page: Page) {
  const connections: unknown[] = [];
  await page.route('**/v1/users/me', (route) => route.fulfill({ json: user }));
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({ json: { items: [workspace], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({ json: { items: connections, nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections`,
    async (route) => {
      const request = route.request();
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.postDataJSON()).toEqual({
        providerKey: 'slack',
        name: 'Incident Slack',
        credential: {
          schemaVersion: 1,
          type: 'slack_bot_token',
          botToken,
        },
      });
      const connection = {
        id: connectionId,
        workspaceId,
        providerKey: 'slack',
        name: 'Incident Slack',
        authType: 'slack_bot_token',
        status: 'active',
        secretVersionId,
        health: {
          lastTestedAt: null,
          lastHealthyAt: null,
          lastErrorCode: null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      connections.push(connection);
      await route.fulfill({ status: 201, json: connection });
    },
  );
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({ json: { items: [workflow], nextCursor: null } }),
  );
  await page.route('**/v1/node-definitions', (route) =>
    route.fulfill({
      json: { schemaVersion: 1, release, items: [slackDefinition] },
    }),
  );
  await page.route('**/v1/integrations', (route) =>
    route.fulfill({ json: { schemaVersion: 1, release, items: [] } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
    (route) =>
      route.fulfill({
        headers: {
          'content-type': 'application/json',
          etag: `"draft-v1.${'a'.repeat(43)}"`,
        },
        body: JSON.stringify({
          workflowId,
          revision: 1,
          schemaVersion: 1,
          graph: {
            schemaVersion: 1,
            nodes: [
              {
                id: 'slack-node',
                definition: { key: 'slack.send', version: 1 },
                position: { x: 80, y: 80 },
                configVersion: 1,
                config: {},
                inputMappings: {},
                connectionRefs: {},
              },
            ],
            edges: [],
            settings: {},
          },
          compatibility: {
            compatible: true,
            fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
            issues: [],
          },
          updatedAt: timestamp,
        }),
      }),
  );
}

test('creates a connection and exposes its safe identity to the editor picker', async ({
  context,
  page,
}) => {
  await context.addCookies([
    { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
  ]);
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/connections`);

  const navigation = page.getByRole('navigation', {
    name: 'Workspace navigation',
  });
  await expect(
    navigation.getByRole('link', { name: 'Connections' }),
  ).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByLabel('Connection name').fill('Incident Slack');
  await page.getByLabel('Slack bot token').fill(botToken);
  await page.getByRole('button', { name: 'Add connection' }).click();
  await expect(page.getByText('Incident Slack')).toBeVisible();
  await expect(page.getByText(botToken)).toHaveCount(0);

  await navigation.getByRole('link', { name: 'Workflows' }).click();
  await page.getByRole('button', { name: 'Slack incident alert' }).click();
  await page.getByTestId('rf__node-slack-node').click();
  await expect(page.getByLabel('Slack bot token')).toHaveValue('');
  await expect(
    page.getByLabel('Slack bot token').getByRole('option', {
      name: 'Incident Slack',
    }),
  ).toHaveCount(1);
});

test('tests, rotates and revokes a connection without exposing credentials', async ({
  context,
  page,
}) => {
  const nextToken = 'xoxb-1234567890-browser-rotated';
  let currentSecretVersionId = secretVersionId;
  let status: 'active' | 'revoked' = 'active';
  let lastTestedAt: string | null = null;
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
      lastErrorCode: null,
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
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}/test`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      expect(route.request().postDataJSON()).toEqual({ providerKey: 'slack' });
      lastTestedAt = '2026-09-15T11:00:00.000Z';
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
          schemaVersion: 1,
          type: 'slack_bot_token',
          botToken: nextToken,
        },
      });
      currentSecretVersionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      await route.fulfill({ json: currentConnection() });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    async (route) => {
      expect(route.request().method()).toBe('DELETE');
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      status = 'revoked';
      await route.fulfill({ json: currentConnection() });
    },
  );

  await page.goto(`/w/${workspaceId}/connections`);
  await page.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByText('Connection test passed.')).toBeVisible();
  await page.getByRole('button', { name: 'Rotate token' }).click();
  await page.getByLabel('New Slack bot token').fill(nextToken);
  await page.getByRole('button', { name: 'Rotate token' }).click();
  await expect(
    page.getByRole('heading', { name: 'Rotate Incident Slack token' }),
  ).toHaveCount(0);
  await expect(page.getByText(nextToken)).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Revoke connection' }).click();
  await expect(page.getByText('revoked')).toBeVisible();
});
