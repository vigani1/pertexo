import { expect, test } from '@playwright/test';
import {
  addCsrfCookie,
  definition,
  editorNode,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
} from './workflow-editor-support';

const connectionId = '44444444-4444-4444-8444-444444444444';

const slackDefinition = {
  ...definition,
  definition: { key: 'slack.send_message', version: 1 },
  family: 'action',
  configSchema: { type: 'object', properties: {} },
  connectionRequirements: ['slack_bot_token'],
  credentialRequirements: ['slack_bot_token'],
};

test('shows a Slack step’s channel name beside its ID, and why when it can’t', async ({
  context,
  page,
}) => {
  const lookups: string[] = [];
  const remote = remoteDraft({
    schemaVersion: 1,
    nodes: [
      {
        ...editorNode('post', 'Tell ops', 'unused', 80),
        definition: { key: 'slack.send_message', version: 1 },
        config: {},
        inputMappings: { channelId: { kind: 'literal', value: 'C0123456789' } },
        connectionRefs: { slack_bot_token: connectionId },
      },
    ],
    edges: [],
    settings: {},
  });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [slackDefinition],
    accessibleWorkspace: {
      ...workspace,
      capabilities: [...workspace.capabilities, 'connection:use'],
    },
  });
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: connectionId,
            workspaceId,
            providerKey: 'slack',
            name: 'Ops bot',
            authType: 'slack_bot_token',
            status: 'active',
            secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            health: {
              lastTestedAt: null,
              lastHealthyAt: null,
              lastErrorCode: null,
            },
            createdAt: '2026-09-14T10:00:00.000Z',
            updatedAt: '2026-09-14T10:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${connectionId}/slack/channels?**`,
    (route) => {
      const channelIds =
        new URL(route.request().url()).searchParams.get('channelIds') ?? '';
      lookups.push(channelIds);
      return route.fulfill({
        json: {
          items: channelIds
            .split(',')
            .map((channelId) =>
              channelId === 'C0123456789'
                ? { channelId, status: 'resolved', name: 'ops-alerts' }
                : { channelId, status: 'unresolved', reason: 'missing_scope' },
            ),
        },
      });
    },
  );
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-post').focus();
  await page.keyboard.press('Enter');

  const field = page.getByLabel('Channel ID', { exact: true });
  await expect(field).toHaveValue('C0123456789');
  await expect(field).toHaveAccessibleDescription(/#ops-alerts/u);

  await field.fill('C0404');
  await page.keyboard.press('Tab');
  await expect(
    page.getByText(
      /Showing the channel ID\. The Slack app needs the channels:read scope/u,
    ),
  ).toBeVisible();
  expect(lookups).toEqual(['C0123456789', 'C0404']);
  await expect
    .poll(
      () =>
        (
          remote.graph.nodes[0] as {
            inputMappings?: Record<string, unknown>;
          }
        ).inputMappings?.channelId,
      { timeout: 4_000 },
    )
    .toEqual({ kind: 'literal', value: 'C0404' });
});
