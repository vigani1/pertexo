import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  describeOAuth2,
  startOAuth2Harness,
  useOAuth2Timeouts,
  type Connection,
  type OAuth2Harness,
  type Owner,
} from '../../support/oauth2/harness.js';
import type { OAuth2Step } from '../../support/oauth2/graphs.js';

useOAuth2Timeouts();

const ONE_ATTEMPT = { maximumAttempts: 1, delayMillis: 1_000 };
const TWO_ATTEMPTS = { maximumAttempts: 2, delayMillis: 1_000 };

describeOAuth2('when an OAuth2 step renews its token', () => {
  let harness: OAuth2Harness;
  let owner: Owner;

  beforeAll(async () => {
    harness = await startOAuth2Harness('steps-renewal');
    owner = await harness.newOwner();
  });
  afterAll(async () => {
    await harness.close();
  });

  const get = (
    connection: Connection,
    extra: Partial<OAuth2Step> = {},
  ): OAuth2Step => ({
    connectionId: connection.id,
    method: 'GET',
    url: harness.apiUrl(),
    ...extra,
  });

  const tokenCalls = (connection: Connection): number =>
    harness.standIn.tokenRequests(connection.clientId).length;

  const apiCalls = (connection: Connection): number =>
    harness.standIn.apiCalls(connection.clientId).length;

  // Getting a token, step 2: a fresh token makes no token request.
  it.fails('a fresh token makes no token request', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    const exchanged = tokenCalls(connection);
    const runId = await harness.run(owner, get(connection));
    expect((await harness.finish(runId)).status).toBe('succeeded');
    expect(tokenCalls(connection)).toBe(exchanged);
  });

  // Constants: renew when the token expires within 60 s.
  it.fails.each([
    ['already expired', -60],
    ['expiring within 60 seconds', 30],
  ])('renews a token %s before calling', async (_name, seconds) => {
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.expireToken(connection.id, seconds);
    const exchanged = tokenCalls(connection);
    const runId = await harness.run(owner, get(connection));
    expect((await harness.finish(runId)).status).toBe('succeeded');
    expect(tokenCalls(connection)).toBe(exchanged + 1);
    const [refresh] = harness.standIn
      .tokenRequests(connection.clientId)
      .slice(-1);
    expect(refresh?.form?.grant_type).toBe('refresh_token');
    expect(apiCalls(connection)).toBe(1);
  });

  // Constants: a token with more than 60 s left isn't renewed.
  it.fails('doesn’t renew a token with more than 60 seconds left', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.expireToken(connection.id, 120);
    const exchanged = tokenCalls(connection);
    await harness.finish(await harness.run(owner, get(connection)));
    expect(tokenCalls(connection)).toBe(exchanged);
  });

  // L5: a response with no refresh_token keeps the stored one.
  it.fails('L5 keeps the refresh token when the answer has none', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    for (const _ of [1, 2]) {
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('succeeded');
    }
    const refreshes = harness.standIn
      .tokenRequests(connection.clientId)
      .map(({ form }) => form?.refresh_token)
      .filter((value) => value !== undefined);
    expect(refreshes).toHaveLength(2);
    expect(refreshes[0]).toBe(refreshes[1]);
  });

  // L5: one with a new refresh token replaces it.
  it.fails('L5 sends the rotated refresh token next time', async () => {
    const connection = await harness.connected(owner, 'rotating');
    for (const _ of [1, 2]) {
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('succeeded');
    }
    const refreshes = harness.standIn
      .tokenRequests(connection.clientId)
      .map(({ form }) => form?.refresh_token)
      .filter((value) => value !== undefined);
    expect(refreshes).toHaveLength(2);
    expect(refreshes[0]).not.toBe(refreshes[1]);
  });

  // L5: renewing client credentials is a new token request.
  it.fails(
    'L5 renews client credentials with a new token request',
    async () => {
      const connection = await harness.createServer(owner, 'non-rotating');
      expect(
        (await harness.start(owner.api, owner, connection.id)).status,
      ).toBe(200);
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('succeeded');
      const grants = harness.standIn
        .tokenRequests(connection.clientId)
        .map(({ form }) => form?.grant_type);
      expect(grants).toEqual(['client_credentials', 'client_credentials']);
    },
  );

  // Getting a token, step 3: due, not renewable, and expired loses the grant.
  it.fails(
    'an expired token with no way to renew loses the grant',
    async () => {
      const connection = await harness.connected(owner, 'no-refresh');
      await harness.expireToken(connection.id);
      const exchanged = tokenCalls(connection);
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('failed');
      const [attempt] = await harness.attempts(runId);
      expect(attempt).toMatchObject({
        safe_error_code: 'http.oauth2_token_expired',
        error_summary:
          'The access token expired and the service gave no way to renew it. Reconnect it in Connections.',
        executor_possibly_dispatched: false,
      });
      expect(tokenCalls(connection)).toBe(exchanged);
      expect(apiCalls(connection)).toBe(0);
      expect(await harness.connection(connection.id)).toMatchObject({
        status: 'reauthorization_required',
        last_error_code: 'connection.oauth2_token_expired',
      });
    },
  );

  // Getting a token, step 3: due, not renewable, not yet expired: still used.
  it.fails(
    'a nearly expired token with no way to renew is still used',
    async () => {
      const connection = await harness.connected(owner, 'no-refresh');
      await harness.expireToken(connection.id, 30);
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('succeeded');
      expect((await harness.connection(connection.id)).status).toBe('active');
    },
  );

  // Getting a token, step 1: not active fails with its own code and no network.
  it.fails(
    'a connection that isn’t connected fails without any request',
    async () => {
      const connection = await harness.create(owner, 'non-rotating');
      const runId = await harness.run(owner, {
        ...get(connection),
        retry: ONE_ATTEMPT,
      });
      expect((await harness.finish(runId)).status).toBe('failed');
      const [attempt] = await harness.attempts(runId);
      expect(attempt).toMatchObject({
        safe_error_code: 'http.oauth2_not_connected',
        error_summary:
          "This connection isn't connected. Reconnect it in Connections.",
        executor_possibly_dispatched: false,
      });
      expect(tokenCalls(connection)).toBe(0);
      expect(apiCalls(connection)).toBe(0);
    },
  );

  // L16: a step retried across a refresh keeps its dispatch binding.
  it.fails(
    'L16 a refresh between attempts keeps the dispatch binding',
    async () => {
      const connection = await harness.connected(owner, 'non-rotating');
      await harness.expireToken(connection.id);
      harness.standIn.scriptAnswers(connection.clientId, ['503']);
      const runId = await harness.run(owner, {
        ...get(connection),
        retry: TWO_ATTEMPTS,
      });
      expect((await harness.finish(runId)).status).toBe('succeeded');
      const attempts = await harness.attempts(runId);
      expect(attempts).toHaveLength(2);
      expect(
        (await harness.connection(connection.id)).current_secret_version_id,
      ).toBe(connection.secretVersionId);
    },
  );

  // L16: "Replacing settings changes it, and those attempts fail before dispatch".
  it.fails(
    'L16 replacing settings fails a queued attempt before it dispatches',
    async () => {
      const connection = await harness.connected(owner, 'non-rotating');
      await harness.expireToken(connection.id);
      const hold = harness.standIn.holdNextToken(connection.clientId);
      const runId = await harness.run(
        owner,
        get(connection, { method: 'POST' }),
      );
      await hold.arrived;
      const replaced = await owner.api.call(
        'PUT',
        `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/secret`,
        {
          expectedSecretVersionId: connection.secretVersionId,
          credential: {
            type: 'oauth2',
            settings: harness.settings(connection.clientId),
            clientSecret: connection.clientSecret,
          },
        },
        { 'idempotency-key': crypto.randomUUID() },
      );
      expect(replaced.status).toBe(200);
      hold.release();
      await harness.finish(runId);
      expect(apiCalls(connection)).toBe(0);
      expect(await harness.tokenRow(connection.id)).toBeUndefined();
    },
  );

  // Step failure table, plan's other row: every failure says the API was never called.
  it.fails(
    'a retried POST whose token failed never reached the API',
    async () => {
      const connection = await harness.connected(owner, 'non-rotating');
      await harness.expireToken(connection.id);
      harness.standIn.scriptAnswers(connection.clientId, ['503']);
      const runId = await harness.run(owner, {
        ...get(connection, { method: 'POST' }),
        retry: TWO_ATTEMPTS,
      });
      expect((await harness.finish(runId)).status).toBe('succeeded');
      expect(apiCalls(connection)).toBe(1);
      const attempts = await harness.attempts(runId);
      expect(attempts[0]?.executor_possibly_dispatched).toBe(false);
      expect(attempts[0]?.dispatch_marked_at).toBeNull();
    },
  );
});
