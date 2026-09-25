import { describe, expect, it } from 'vitest';

import {
  CONNECTION_AUTH_TYPE,
  ConnectionNotFoundError,
  ConnectionUnavailableError,
  Pool,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  ownerB,
  randomUUID,
  registerCurrentConnectionsFixture,
  workspaceA,
  workspaceB,
} from './support/connections.integration.support.js';

const connections = registerCurrentConnectionsFixture();

async function credentialAccessFacts(connectionId: string) {
  const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceA,
    ]);
    const facts = await client.query<Record<string, unknown>>(
      `select actor_kind, actor_id, request_id, trace_id, metadata
         from app.connection_events
        where connection_id = $1
          and event_type = 'connection.credential_accessed'`,
      [connectionId],
    );
    const health = await client.query<Record<string, unknown>>(
      'select status, last_tested_at from app.connections where id = $1',
      [connectionId],
    );
    await client.query('rollback');
    return { facts: facts.rows, health: health.rows };
  } finally {
    client.release();
    await owner.end();
  }
}

const lookupPurpose = 'slack.channel_lookup';

describe('connection lookup credential resolution (ADR 046)', () => {
  it('resolves the current secret for a connection user and audits the access', async () => {
    const input = createInput({
      providerKey: 'slack',
      authType: CONNECTION_AUTH_TYPE.slackBotToken,
    });
    await connections.api.createConnection(input);

    const resolved = await connections.api.resolveConnectionLookupSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'slack',
      purpose: lookupPurpose,
      requestId: 'request-channel-lookup',
      traceId: 'trace-channel-lookup',
    });

    expect(resolved).toMatchObject({
      connection: { id: input.connectionId, status: 'active' },
      secretVersionId: input.secretVersionId,
      sealed: input.sealed,
    });
    await expect(credentialAccessFacts(input.connectionId)).resolves.toEqual({
      facts: [
        {
          actor_kind: 'user',
          actor_id: ownerA,
          request_id: 'request-channel-lookup',
          trace_id: 'trace-channel-lookup',
          metadata: {
            purpose: lookupPurpose,
            secretVersionId: input.secretVersionId,
          },
        },
      ],
      health: [{ status: 'active', last_tested_at: null }],
    });
  });

  it('hides invisible connections and refuses unusable ones without an audit fact', async () => {
    const slack = createInput({
      providerKey: 'slack',
      authType: CONNECTION_AUTH_TYPE.slackBotToken,
    });
    const http = createInput();
    await connections.api.createConnection(slack);
    await connections.api.createConnection(http);
    const lookup = (overrides: Readonly<Record<string, string>>) =>
      connections.api.resolveConnectionLookupSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: slack.connectionId,
        expectedProviderKey: 'slack',
        purpose: lookupPurpose,
        ...overrides,
      });

    for (const hidden of [
      { connectionId: randomUUID() },
      { actorId: randomUUID() },
      { workspaceId: workspaceB, actorId: ownerB },
    ])
      await expect(lookup(hidden)).rejects.toBeInstanceOf(
        ConnectionNotFoundError,
      );
    await expect(
      lookup({ connectionId: http.connectionId }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(lookup({ purpose: 'Slack lookup' })).rejects.toThrow();

    await connections.api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: slack.connectionId,
    });
    await expect(lookup({})).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(credentialAccessFacts(slack.connectionId)).resolves.toEqual({
      facts: [],
      health: [{ status: 'revoked', last_tested_at: null }],
    });
  });
});
