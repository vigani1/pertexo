import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  describeOAuth2,
  REDIRECT_URI,
  startOAuth2Harness,
  useOAuth2Timeouts,
  type Connection,
  type OAuth2Harness,
  type Owner,
} from '../../support/oauth2/harness.js';

useOAuth2Timeouts();

const TEST_URL = 'https://api.public.example.test/api';

describeOAuth2('an OAuth2 connection changing state', () => {
  let harness: OAuth2Harness;

  beforeAll(async () => {
    harness = await startOAuth2Harness('life-transitions');
  });
  afterAll(async () => {
    await harness.close();
  });

  const replace = (owner: Owner, connection: Connection, credential: unknown) =>
    owner.api.call(
      'PUT',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/secret`,
      { expectedSecretVersionId: connection.secretVersionId, credential },
      { 'idempotency-key': randomUUID() },
    );

  const revoke = (owner: Owner, connection: Connection) =>
    owner.api.call(
      'DELETE',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}`,
    );

  const usedStep = (connection: Connection) =>
    ({
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(),
    }) as const;

  const healthRevision = async (id: string): Promise<bigint> =>
    BigInt((await harness.connection(id)).health_revision);

  // D4: create stores connection, secret version and client, with the not-yet-connected code.
  it.fails('D4 a new connection is not connected yet', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    expect(connection.body).toMatchObject({
      providerKey: 'http',
      authType: 'oauth2',
      status: 'reauthorization_required',
      health: { lastErrorCode: 'connection.oauth2_not_authorized' },
      oauth2: {
        redirectUri: REDIRECT_URI,
        settings: { clientId: connection.clientId },
      },
    });
    expect(connection.body).not.toHaveProperty('grant');
    const clients = await harness.stack.sql<{ secret_version_id: string }>(
      `select secret_version_id from app.connection_oauth2_clients where connection_id=$1`,
      [connection.id],
    );
    expect(clients).toEqual([
      { secret_version_id: connection.secretVersionId },
    ]);
    expect(await harness.tokenRow(connection.id)).toBeUndefined();
  });

  // D5: consent success is a recorded transition.
  it.fails(
    'D5 consent makes it active, with its event, audit fact and health',
    async () => {
      const owner = await harness.newOwner();
      const connection = await harness.create(owner, 'non-rotating');
      const before = await healthRevision(connection.id);
      const landing = await harness.reconnect(owner, connection);
      expect(landing.result).toBe('connected');
      expect(await harness.connection(connection.id)).toMatchObject({
        status: 'active',
        last_error_code: null,
        current_secret_version_id: connection.secretVersionId,
        last_health_transition_source: 'rotation',
      });
      expect(
        (await harness.connection(connection.id)).last_healthy_at,
      ).not.toBeNull();
      expect(await healthRevision(connection.id)).toBe(before + 1n);
      expect(await harness.events(connection.id)).toContain(
        'connection.oauth2_authorized',
      );
      const audit = await harness.stack.sql<{ action: string }>(
        `select action from app.audit_events where target_id=$1`,
        [connection.id],
      );
      expect(audit.map(({ action }) => action)).toContain(
        'connection.oauth2_authorized',
      );
    },
  );

  // D5: a refresh writes only the token row and lastHealthyAt: no event, no revision.
  it.fails('D5 a refresh changes the token, not the connection', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'rotating');
    const tokenBefore = await harness.tokenRow(connection.id);
    const revisionBefore = await healthRevision(connection.id);
    const eventsBefore = await harness.events(connection.id);
    await harness.expireToken(connection.id);
    const runId = await harness.run(owner, usedStep(connection));
    expect((await harness.finish(runId)).status).toBe('succeeded');
    const tokenAfter = await harness.tokenRow(connection.id);
    expect(tokenAfter?.id).not.toBe(tokenBefore?.id);
    const stored = await harness.connection(connection.id);
    expect(stored.current_secret_version_id).toBe(connection.secretVersionId);
    expect(tokenAfter?.secret_version_id).toBe(connection.secretVersionId);
    expect(await healthRevision(connection.id)).toBe(revisionBefore);
    const newEvents = (await harness.events(connection.id)).filter(
      (type) => type !== 'connection.credential_accessed',
    );
    expect(newEvents).toEqual(
      eventsBefore.filter((type) => type !== 'connection.credential_accessed'),
    );
  });

  // D6: losing a grant from a worker is source run.
  it.fails(
    'D6 invalid_grant in a run deletes tokens and records the transition',
    async () => {
      const owner = await harness.newOwner();
      const connection = await harness.connected(owner, 'rotating');
      const before = await healthRevision(connection.id);
      harness.standIn.revoke(connection.clientId);
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, usedStep(connection));
      expect((await harness.finish(runId)).status).toBe('failed');
      expect(await harness.tokenRow(connection.id)).toBeUndefined();
      expect(await harness.connection(connection.id)).toMatchObject({
        status: 'reauthorization_required',
        last_error_code: 'connection.oauth2_grant_revoked',
        last_health_transition_source: 'run',
      });
      expect(await healthRevision(connection.id)).toBe(before + 1n);
      expect(await harness.events(connection.id)).toContain(
        'connection.reauthorization_required',
      );
    },
  );

  // D6: and from a connection test, source test.
  it.fails('D6 invalid_grant in a test records source test', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'rotating');
    harness.standIn.revoke(connection.clientId);
    await harness.expireToken(connection.id);
    await harness.test(owner, connection.id, TEST_URL);
    expect(await harness.connection(connection.id)).toMatchObject({
      status: 'reauthorization_required',
      last_error_code: 'connection.oauth2_grant_revoked',
      last_health_transition_source: 'test',
    });
    expect(await harness.tokenRow(connection.id)).toBeUndefined();
  });

  // Plan outcome: reconnecting works without touching the workflows that use it.
  it.fails(
    'a reconnect restores it without changing the secret version',
    async () => {
      const owner = await harness.newOwner();
      const connection = await harness.connected(owner, 'rotating');
      harness.standIn.revoke(connection.clientId);
      await harness.expireToken(connection.id);
      await harness.finish(await harness.run(owner, usedStep(connection)));
      expect((await harness.connection(connection.id)).status).toBe(
        'reauthorization_required',
      );
      const landing = await harness.reconnect(owner, connection);
      expect(landing.result).toBe('connected');
      expect(await harness.connection(connection.id)).toMatchObject({
        status: 'active',
        last_error_code: null,
        current_secret_version_id: connection.secretVersionId,
      });
      const runId = await harness.run(owner, usedStep(connection));
      expect((await harness.finish(runId)).status).toBe('succeeded');
    },
  );

  // S22: changing any setting needs the secret in the same request.
  it.fails('S22 replacing settings without the secret is refused', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    const tokenBefore = await harness.tokenRow(connection.id);
    const replaced = await replace(owner, connection, {
      type: 'oauth2',
      settings: harness.settings(connection.clientId, {
        tokenUrl: `${harness.standIn.origin}/attacker-token`,
      }),
    });
    expect(replaced.status).toBe(400);
    expect((await harness.tokenRow(connection.id))?.id).toBe(tokenBefore?.id);
    const [client] = await harness.stack.sql<{ count: number }>(
      `select count(*)::int as count from app.connection_oauth2_clients
        where connection_id=$1 and settings->>'tokenUrl' like '%attacker%'`,
      [connection.id],
    );
    expect(client?.count).toBe(0);
  });

  // S22, D4, L16: replacing drops tokens and pending consent and asks for consent again.
  it.fails('S22 replacing drops tokens and asks for new consent', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.start(owner.api, owner, connection.id);
    const replaced = await replace(owner, connection, {
      type: 'oauth2',
      settings: harness.settings(connection.clientId, { scope: 'read write' }),
      clientSecret: connection.clientSecret,
    });
    expect(replaced.status).toBe(200);
    const body = replaced.json as { secretVersionId: string };
    expect(body.secretVersionId).not.toBe(connection.secretVersionId);
    expect(replaced.json).toMatchObject({
      status: 'reauthorization_required',
      health: { lastErrorCode: 'connection.oauth2_not_authorized' },
    });
    expect(await harness.tokenRow(connection.id)).toBeUndefined();
    expect(await harness.pendingRows(connection.id)).toBe(0);
    const [client] = await harness.stack.sql<{ count: number }>(
      `select count(*)::int as count from app.connection_oauth2_clients
        where connection_id=$1`,
      [connection.id],
    );
    expect(client?.count).toBe(2);
  });

  // D4: "An OAuth2 connection can't become a header one or the reverse".
  it.fails('D4 refuses a type change in both directions', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const toHeaders = await replace(owner, connection, {
      type: 'http_headers',
      headers: { authorization: 'Bearer value' },
    });
    expect(toHeaders.status).toBe(409);
    const created = await owner.api.call(
      'POST',
      `/v1/workspaces/${owner.workspaceId}/connections`,
      {
        providerKey: 'http',
        name: `Headers ${randomUUID().slice(0, 8)}`,
        credential: {
          type: 'http_headers',
          headers: { authorization: 'Bearer value' },
        },
      },
      { 'idempotency-key': randomUUID() },
    );
    const headers = created.json as { id: string; secretVersionId: string };
    const toOAuth2 = await replace(
      owner,
      {
        ...connection,
        id: headers.id,
        secretVersionId: headers.secretVersionId,
      },
      {
        type: 'oauth2',
        settings: harness.settings('client'),
        clientSecret: 'a-secret',
      },
    );
    expect(toOAuth2.status).toBe(409);
  });

  // D7: revoke deletes tokens and pending consent; the sealed secret stays.
  it.fails(
    'D7 revoke deletes tokens and pending consent, not the sealed secret',
    async () => {
      const owner = await harness.newOwner();
      const connection = await harness.connected(owner, 'non-rotating');
      await harness.start(owner.api, owner, connection.id);
      expect(await harness.pendingRows(connection.id)).toBe(1);
      expect((await revoke(owner, connection)).status).toBeLessThan(300);
      expect(await harness.tokenRow(connection.id)).toBeUndefined();
      expect(await harness.pendingRows(connection.id)).toBe(0);
      expect((await harness.connection(connection.id)).status).toBe('revoked');
      const [secret] = await harness.stack.sql<{ count: number }>(
        `select count(*)::int as count from app.connection_secret_versions where connection_id=$1`,
        [connection.id],
      );
      expect(secret?.count).toBe(1);
      // "Revoke: deletes tokens here; doesn't call the provider".
      expect(harness.standIn.requests.at(-1)?.path).not.toBe('/revoke');
    },
  );
});
