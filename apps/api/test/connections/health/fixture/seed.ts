import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import {
  connectionResponseSchema,
  connectionUsageResponseSchema,
} from '@pertexo/contracts';

import type {
  ConnectionHealthFixtureState,
  ConnectionHealthApi,
} from './contract.js';

export async function seedConnectionHealthFixture(
  input: Readonly<{
    api: ConnectionHealthApi;
    token: string;
    state: ConnectionHealthFixtureState;
  }>,
) {
  const { api, token, state } = input;

  const email = `${randomUUID()}@example.test`;
  await api.signUp(email, '/login?verified=true');
  state.browser = await api.signIn(email);
  const created = await api.send('POST', '/v1/workspaces', {
    browser: state.browser,
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      name: 'Health qualification',
      slug: `health-${randomUUID().slice(0, 8)}`,
    },
  });
  expect(created.statusCode, created.payload).toBe(201);
  state.workspaceId = created.json<{ id: string }>().id;
  state.actorId =
    (
      await api
        .database()
        .query<{ id: string }>('select id from app.users where email=$1', [
          email,
        ])
    ).rows[0]?.id ?? '';
  const connection = await api.send(
    'POST',
    `/v1/workspaces/${state.workspaceId}/connections`,
    {
      browser: state.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        providerKey: 'slack',
        name: 'Incident Slack',
        credential: {
          type: 'slack_bot_token',
          botToken: token,
        },
      },
    },
  );
  expect(connection.statusCode, connection.payload).toBe(201);
  state.connectionId = connectionResponseSchema.parse(connection.json()).id;
  const workflow = await api.send(
    'POST',
    `/v1/workspaces/${state.workspaceId}/workflows`,
    {
      browser: state.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { name: 'Health sender' },
    },
  );
  expect(workflow.statusCode, workflow.payload).toBe(201);
  state.workflowId = workflow.json<{ workflow: { id: string } }>().workflow.id;
  const route = `/v1/workspaces/${state.workspaceId}/workflows/${state.workflowId}`,
    nodeId = randomUUID();
  for (let version = 1; version <= 2; version++) {
    const draft = await api.send('GET', `${route}/draft`, {
      browser: state.browser,
    });
    const saved = await api.send('PUT', `${route}/draft`, {
      browser: state.browser,
      headers: { 'if-match': String(draft.headers.etag) },
      payload: {
        graph: {
          nodes: [
            {
              id: nodeId,
              definition: { key: 'slack.send_message', version: 1 },
              label: 'Controlled Slack send',
              position: { x: version, y: 0 },
              configVersion: 1,
              config: { timeoutMillis: 30000 },
              inputMappings: {
                channelId: { kind: 'literal', value: 'C123ABC' },
                text: {
                  kind: 'literal',
                  value: `Owned health ${String(version)}`,
                },
              },
              connectionRefs: { slack_bot_token: state.connectionId },
            },
          ],
          edges: [],
          settings: {},
        },
      },
    });
    expect(saved.statusCode, saved.payload).toBe(200);
    const published = await api.send('POST', `${route}/publish`, {
      browser: state.browser,
      headers: {
        'if-match': String(saved.headers.etag),
        'idempotency-key': randomUUID(),
      },
    });
    expect(published.statusCode, published.payload).toBe(200);
  }
  const usage = await api.send(
    'GET',
    `/v1/workspaces/${state.workspaceId}/connections/${state.connectionId}/usage`,
    { browser: state.browser },
  );
  expect(connectionUsageResponseSchema.parse(usage.json()).items).toHaveLength(
    2,
  );
  return {
    workspaceId: state.workspaceId,
    connectionId: state.connectionId,
    workflowId: state.workflowId,
    browser: state.browser,
  };
}
