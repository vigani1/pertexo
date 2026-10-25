import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../test/support/fixtures/identity';
import { expect, type Page } from '../support/fixtures';
import {
  routeEmptyWorkflowOrganization,
  workflowListBody,
} from '../workflows/list-support';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const secretVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const csrfToken = 'csrf-token-for-connections-tests-123456789012345678';

export const botToken = 'xoxb-1234567890-browser-secret';

export const timestamp = '2026-09-15T10:00:00.000Z';

export const user = createUserFixture({
  id: userId,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const workspace = createWorkspaceFixture({
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

export async function installRoutes(page: Page) {
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
