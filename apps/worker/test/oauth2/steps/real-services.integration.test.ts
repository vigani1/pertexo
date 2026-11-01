import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { OAUTH2_STAND_IN_DESCRIPTION } from '../../../../../infrastructure/testing/oauth2-stand-in.mjs';
import { httpStepWithErrorPathGraph } from '../../support/oauth2/graphs.js';
import {
  describeOAuth2,
  startOAuth2Harness,
  useOAuth2Timeouts,
  type Connection,
  type OAuth2Harness,
  type Owner,
} from '../../support/oauth2/harness.js';

useOAuth2Timeouts();

const ONE_ATTEMPT = { maximumAttempts: 1, delayMillis: 1_000 };
const UNUSABLE_ANSWER =
  "The service's token address gave an answer Pertexo can't use. Check the token URL.";

/** What the plan's answer table says for each answer, whoever words it. */
const GRANT_LOST = {
  safe_error_code: 'http.oauth2_grant_revoked',
  error_summary:
    "The service no longer accepts this connection's sign-in. Reconnect it in Connections.",
  executor_failure_kind: 'failed',
  executor_error_kind: 'authentication',
  executor_possibly_dispatched: false,
};
const CLIENT_REFUSED = {
  safe_error_code: 'http.oauth2_client_rejected',
  error_summary:
    'The service refused the client ID or secret. Replace them in Connections, then reconnect.',
  executor_failure_kind: 'failed',
  executor_error_kind: 'authentication',
  executor_possibly_dispatched: false,
};

describeOAuth2('how real services differ from the standard', () => {
  let harness: OAuth2Harness;
  let owner: Owner;

  beforeAll(async () => {
    harness = await startOAuth2Harness('steps-real-services');
  });
  // Connecting is limited to 10 a minute per person, the real limit: each test has its own.
  beforeEach(async () => {
    owner = await harness.newOwner();
  });
  afterAll(async () => {
    await harness.close();
  });

  const get = (connection: Connection) =>
    ({
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(),
    }) as const;

  const renewalsWith = async (
    connection: Connection,
    behavior: string,
    retry = ONE_ATTEMPT,
  ) => {
    harness.standIn.setBehavior(connection.clientId, behavior);
    await harness.expireToken(connection.id);
    const runId = await harness.run(owner, { ...get(connection), retry });
    return { runId, ended: await harness.finish(runId) };
  };

  const refreshTokensSent = (connection: Connection) =>
    harness.standIn
      .tokenRequests(connection.clientId)
      .flatMap(({ form }) =>
        form?.grant_type === 'refresh_token' ? [form.refresh_token] : [],
      );

  const issuedRefreshToken = (connection: Connection) =>
    harness.standIn
      .tokenRequests(connection.clientId)
      .find(({ form }) => form?.grant_type === 'authorization_code')?.issued
      ?.refreshToken;

  // M5: a dead connection must not stay Active, retrying forever as "Check the token URL".
  it.each([
    ['Entra', 'entra-interaction-required'],
    ['Entra', 'entra-consent-required'],
    ['GitHub', 'github-bad-refresh'],
  ])('M5 %s refusing with %s loses the grant', async (_who, behavior) => {
    const connection = await harness.connected(owner, 'non-rotating');
    const { runId, ended } = await renewalsWith(connection, behavior);
    expect(ended.status).toBe('failed');
    expect((await harness.attempts(runId))[0]).toMatchObject(GRANT_LOST);
    expect(await harness.connection(connection.id)).toMatchObject({
      status: 'reauthorization_required',
      last_error_code: 'connection.oauth2_grant_revoked',
    });
    expect(await harness.tokenRow(connection.id)).toBeUndefined();
  });

  it('M5 GitHub refusing the client with a 200 needs new client details', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    const { runId, ended } = await renewalsWith(
      connection,
      'github-bad-credentials',
    );
    expect(ended.status).toBe('failed');
    expect((await harness.attempts(runId))[0]).toMatchObject(CLIENT_REFUSED);
    expect(await harness.connection(connection.id)).toMatchObject({
      status: 'reauthorization_required',
      last_error_code: 'connection.oauth2_client_rejected',
    });
    expect(await harness.tokenRow(connection.id)).toBeUndefined();
  });

  // L10 stays: an error nobody has listed is temporary and changes nothing.
  it('an unknown error stays temporary', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    const { runId } = await renewalsWith(connection, 'unknown-error');
    expect((await harness.attempts(runId))[0]).toMatchObject({
      safe_error_code: 'http.oauth2_token_response_invalid',
      executor_failure_kind: 'retry',
      executor_error_kind: 'provider',
      executor_possibly_dispatched: false,
    });
    expect(harness.standIn.apiCalls(connection.clientId)).toEqual([]);
    expect((await harness.connection(connection.id)).status).toBe('active');
  });

  // M5, related: the service's short code gives a person something to act on.
  it('M5 a step shows the service’s short error code', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    const { runId } = await renewalsWith(connection, 'unknown-error');
    const [attempt] = await harness.attempts(runId);
    expect(attempt?.error_summary).toContain('stand_in_unknown_error');
    expect(attempt?.error_summary).not.toContain(OAUTH2_STAND_IN_DESCRIPTION);
  });

  it('M5 a landing page shows the service’s short error code', async () => {
    const connection = await harness.create(owner, 'unknown-error');
    const landing = await harness.reconnect(owner, connection);
    expect(landing.result).toBe('token_refused');
    expect(landing.location).toContain('stand_in_unknown_error');
    expect(landing.location).not.toContain(OAUTH2_STAND_IN_DESCRIPTION);
  });

  // S9, M5: only `[a-z_]` is ever repeated: the rest is a service's free text.
  it('an error that isn’t a short code is never repeated', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    const { runId } = await renewalsWith(connection, 'unsafe-error');
    const [attempt] = await harness.attempts(runId);
    expect(attempt?.error_summary).toBe(UNUSABLE_ANSWER);
    const consent = await harness.create(owner, 'unsafe-error');
    const landing = await harness.reconnect(owner, consent);
    expect(landing.result).toBe('token_refused');
    expect(landing.location).not.toContain('Thing');
  });

  // M6: Google gives a refresh token only on first consent unless asked again.
  it('M6 reconnecting without a new refresh token keeps renewal working', async () => {
    const connection = await harness.connected(
      owner,
      'refresh-on-first-consent',
    );
    const held = issuedRefreshToken(connection);
    expect(held).toMatch(/^stand-in-rt-/u);
    expect((await harness.reconnect(owner, connection)).result).toBe(
      'connected',
    );
    expect((await harness.tokenRow(connection.id))?.renewable).toBe(true);
    await harness.expireToken(connection.id);
    const runId = await harness.run(owner, get(connection));
    expect((await harness.finish(runId)).status).toBe('succeeded');
    expect(refreshTokensSent(connection)).toEqual([held]);
  });

  // M6's limit: "when the secret version is unchanged". New client details are a
  // different sign-in, so an old refresh token must not carry over.
  it('M6 new client details never keep the old refresh token', async () => {
    const connection = await harness.connected(
      owner,
      'refresh-on-first-consent',
    );
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
      { 'idempotency-key': randomUUID() },
    );
    expect(replaced.status).toBe(200);
    expect((await harness.reconnect(owner, connection)).result).toBe(
      'connected',
    );
    expect((await harness.tokenRow(connection.id))?.renewable).toBe(false);
  });

  // S20's decision: redacting an echoed refresh token would store a broken copy.
  it('a refresh token repeated in each answer keeps working', async () => {
    const connection = await harness.connected(owner, 'echoes-refresh');
    const held = issuedRefreshToken(connection);
    for (let renewal = 0; renewal < 2; renewal += 1) {
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('succeeded');
    }
    expect(refreshTokensSent(connection)).toEqual([held, held]);
    expect((await harness.connection(connection.id)).status).toBe('active');
  });

  // S4: a service that writes absent fields as null can connect.
  it.each(['null-fields', 'empty-refresh-token'])(
    'S4 a %s service connects and its token works',
    async (behavior) => {
      const connection = await harness.connected(owner, behavior);
      expect((await harness.tokenRow(connection.id))?.renewable).toBe(false);
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('succeeded');
      expect(harness.standIn.apiCalls(connection.clientId)).toHaveLength(1);
    },
  );

  // S4: and can renew, keeping the refresh token it already has.
  it('S4 a null refresh token on renewal keeps the one held', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    const held = issuedRefreshToken(connection);
    const { ended } = await renewalsWith(connection, 'null-fields');
    expect(ended.status).toBe('succeeded');
    await harness.expireToken(connection.id);
    const again = await harness.run(owner, get(connection));
    expect((await harness.finish(again)).status).toBe('succeeded');
    expect(refreshTokensSent(connection)).toEqual([held, held]);
  });

  // S5: a rate-limited service must not be asked again every second.
  it.each([
    ['an HTTP date', 'Wed, 21 Oct 2015 07:28:00 GMT'],
    ['zero', '0'],
  ])(
    'S5 %s in Retry-After blocks for the 15 s default',
    async (_name, value) => {
      const connection = await harness.connected(owner, 'non-rotating');
      harness.standIn.setRetryAfter(connection.clientId, value);
      const { runId } = await renewalsWith(connection, '429');
      const [attempt] = await harness.attempts(runId);
      expect(attempt).toMatchObject({
        safe_error_code: 'http.oauth2_token_rate_limited',
        executor_retry_after_millis: 15_000,
      });
      const [blocked] = await harness.stack.sql<{ seconds: number }>(
        `select extract(epoch from refresh_blocked_until - clock_timestamp())::float8 as seconds
         from app.connection_oauth2_tokens where connection_id=$1`,
        [connection.id],
      );
      expect(blocked?.seconds).toBeGreaterThan(5);
      expect(blocked?.seconds).toBeLessThanOrEqual(15);
    },
  );

  // Review, Basic encoding: a service that doesn't decode refuses the RFC's form,
  // and the landing's advice to try the request body really gets the person through.
  it('a service that doesn’t decode Basic refuses, and the body works', async () => {
    const secret = 'a~b+c/d=';
    const connectWith = async (clientAuthentication: string) => {
      const clientId = harness.standIn.newClient('raw-basic');
      harness.standIn.expectSecret(clientId, secret);
      const created = await harness.createResponse(
        owner,
        harness.settings(clientId, { clientAuthentication }),
        secret,
      );
      expect(created.status).toBe(201);
      const { id } = created.json as { id: string };
      const url = harness.authorizationUrl(
        await harness.start(owner.api, owner, id),
      );
      return (
        await harness.land(owner.api, await harness.decide(url, 'approve'))
      ).result;
    };
    expect(await connectWith('basic')).toBe('token_refused');
    expect(await connectWith('body')).toBe('connected');
  });

  // M2: an error path on the step takes a 401 from the API...
  it('an API’s 401 takes a step’s error path', async () => {
    const connection = await harness.connected(owner, 'api-401');
    const workflowId = await owner.api.publish(
      owner.workspaceId,
      `Error path ${randomUUID().slice(0, 8)}`,
      httpStepWithErrorPathGraph({
        ...get(connection),
        retry: ONE_ATTEMPT,
      }),
    );
    const runId = await owner.api.startRun(owner.workspaceId, workflowId);
    expect((await harness.finish(runId)).status).toBe('succeeded');
    expect(await harness.attempts(runId, 'handler')).toMatchObject([
      { status: 'succeeded' },
    ]);
  });

  // M2: ...and must take a revoked grant, the case people most want it for.
  it('M2 a revoked grant takes a step’s error path', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    const workflowId = await owner.api.publish(
      owner.workspaceId,
      `Error path ${randomUUID().slice(0, 8)}`,
      httpStepWithErrorPathGraph({
        ...get(connection),
        retry: ONE_ATTEMPT,
      }),
    );
    harness.standIn.revoke(connection.clientId);
    await harness.expireToken(connection.id);
    const runId = await owner.api.startRun(owner.workspaceId, workflowId);
    expect((await harness.finish(runId)).status).toBe('succeeded');
    expect((await harness.attempts(runId))[0]).toMatchObject({
      safe_error_code: 'http.oauth2_grant_revoked',
    });
    expect(await harness.attempts(runId, 'handler')).toMatchObject([
      { status: 'succeeded' },
    ]);
    expect(await harness.attempts(runId, 'normal-stop')).toEqual([]);
  });
});
