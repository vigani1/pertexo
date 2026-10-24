import {
  createUserFixture,
  createWorkspaceFixture,
} from '../test/support/fixtures/identity';
import { expect, test, type Page } from './support/fixtures';
import {
  routeEmptyWorkflowOrganization,
  workflowListBody,
} from './workflows/list-support';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const secretVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const csrfToken = 'csrf-token-for-connections-tests-123456789012345678';
const botToken = 'xoxb-1234567890-browser-secret';
const timestamp = '2026-09-15T10:00:00.000Z';
const user = createUserFixture({
  id: userId,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const workspace = createWorkspaceFixture({
  id: workspaceId,
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
});
const workflow = {
  id: workflowId,
  workspaceId,
  name: 'Slack incident alert',
  nameRevision: 1,
  lifecycleStatus: 'active',
  lifecycleRevision: 1,
  activationStatus: 'inactive',
  webhookSetupRequired: false,
  publishedVersionId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const slackDefinition = {
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
};

async function installRoutes(page: Page) {
  const connections: Record<string, unknown>[] = [];
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
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}/test`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({ providerKey: 'slack' });
      const connection = connections[0];
      if (connection === undefined)
        throw new Error('The setup test must follow connection creation.');
      connection.health = {
        lastTestedAt: timestamp,
        lastHealthyAt: timestamp,
        lastErrorCode: null,
      };
      await route.fulfill({
        json: {
          connection: connections[0],
          outcome: { ok: true, httpStatus: 200, errorCode: null },
        },
      });
    },
  );
  await routeEmptyWorkflowOrganization(page, workspaceId);
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({
      json: workflowListBody(route.request().url(), [workflow]),
    }),
  );
  await page.route('**/v1/node-definitions', (route) =>
    route.fulfill({
      json: { items: [slackDefinition] },
    }),
  );
  await page.route('**/v1/integrations', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) => route.fulfill({ json: { workflow } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
    (route) =>
      route.fulfill({
        headers: {
          'content-type': 'application/json',
          etag: `"draft.${'a'.repeat(43)}"`,
        },
        body: JSON.stringify({
          workflowId,
          revision: 1,
          graph: {
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
            fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
            issues: [],
          },
          updatedAt: timestamp,
        }),
      }),
  );
}

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
      lastHealthTransitionSource:
        currentSecretVersionId !== secretVersionId
          ? 'rotation'
          : lastTestedAt === null
            ? 'run'
            : 'test',
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

for (const width of [390, 1280]) {
  test(`keeps the HTTP setup-test failure after a reload at ${String(width)} pixels`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await context.addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
    await installRoutes(page);
    let created = false;
    let health = {
      lastTestedAt: null as string | null,
      lastHealthyAt: null as string | null,
      lastErrorCode: null as string | null,
    };
    const connection = () => ({
      id: connectionId,
      workspaceId,
      providerKey: 'http',
      name: 'Billing API',
      authType: 'http_headers',
      status: 'active',
      secretVersionId,
      health,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await page.route(
      `**/v1/workspaces/${workspaceId}/connections?**`,
      (route) =>
        route.fulfill({
          json: { items: created ? [connection()] : [], nextCursor: null },
        }),
    );
    await page.route(`**/v1/workspaces/${workspaceId}/connections`, (route) => {
      created = true;
      return route.fulfill({ status: 201, json: connection() });
    });
    await page.route(
      `**/v1/workspaces/${workspaceId}/connections/${connectionId}/test`,
      (route) => {
        expect(route.request().postDataJSON()).toEqual({
          url: 'https://billing.example.test/me',
        });
        health = {
          lastTestedAt: timestamp,
          lastHealthyAt: null,
          lastErrorCode: 'connection.test.dns_failed',
        };
        return route.fulfill({
          json: {
            connection: connection(),
            outcome: {
              ok: false,
              httpStatus: null,
              errorCode: 'connection.test.dns_failed',
            },
          },
        });
      },
    );
    await page.goto(`/w/${workspaceId}/connections?add=http`);
    const lens = page.locator('[data-slot="sheet-content"]');
    await lens.getByLabel('Header 1 value').fill('Bearer setup-secret');
    await lens.getByRole('button', { name: 'Continue' }).click();
    await lens.getByLabel('Connection name').fill('Billing API');
    await lens.getByRole('button', { name: 'Save and test' }).click();
    await lens
      .getByLabel('Address to call')
      .fill('https://billing.example.test/me');
    await lens.getByRole('button', { name: 'Call this address' }).click();
    await expect(
      lens.getByText('The test failed: address not found.'),
    ).toBeVisible();
    await lens.getByRole('button', { name: 'Done' }).click();
    await expect(
      page.getByText('last test failed · address not found'),
    ).toBeVisible();
    await expect(page.getByText('never tested')).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByText('last test failed · address not found'),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/pertexo-polish-3-${String(width)}.png`,
    });
  });
}
