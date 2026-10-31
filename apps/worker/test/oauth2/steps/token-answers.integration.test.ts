import { afterAll, beforeAll, expect, it } from 'vitest';
import { OAUTH2_STAND_IN_RETRY_AFTER_SECONDS } from '../../../../../infrastructure/testing/oauth2-stand-in.mjs';
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

describeOAuth2('what the token address answers', () => {
  let harness: OAuth2Harness;
  let owner: Owner;

  beforeAll(async () => {
    harness = await startOAuth2Harness('steps-token-answers');
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

  // L9: a temporary failure with a valid token isn't a failure.
  it.each(['503', '429', 'not-json', 'redirect'])(
    'L9 a token address answering %s with a valid token still succeeds',
    async (behavior) => {
      const connection = await harness.connected(owner, 'non-rotating');
      harness.standIn.setBehavior(connection.clientId, behavior);
      await harness.expireToken(connection.id, 30);
      const exchanged = tokenCalls(connection);
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('succeeded');
      expect(apiCalls(connection)).toBe(1);
      expect(tokenCalls(connection)).toBe(exchanged + 1);
      expect((await harness.connection(connection.id)).status).toBe('active');
    },
  );

  // L9, L10: with an expired token it retries, status stays active, then recovers.
  it('L9 an outage with an expired token retries, then recovers', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    harness.standIn.setBehavior(connection.clientId, '503');
    await harness.expireToken(connection.id);
    const runId = await harness.run(owner, {
      ...get(connection),
      retry: { maximumAttempts: 5, delayMillis: 1_000 },
    });
    // The attempt has really met the outage before the service recovers.
    await expect
      .poll(async () => (await harness.attempts(runId))[0]?.safe_error_code, {
        timeout: 60_000,
      })
      .toBe('http.oauth2_token_endpoint_unavailable');
    expect((await harness.connection(connection.id)).status).toBe('active');
    // Past the 15 s block, so the next attempt may really ask.
    await harness.stack.sql(
      `update app.connection_oauth2_tokens set refresh_blocked_until=null where connection_id=$1`,
      [connection.id],
    );
    harness.standIn.setBehavior(connection.clientId, 'non-rotating');
    expect((await harness.finish(runId)).status).toBe('succeeded');
    const attempts = await harness.attempts(runId);
    expect(attempts[0]).toMatchObject({
      safe_error_code: 'http.oauth2_token_endpoint_unavailable',
      error_summary: "The service's token address didn't answer.",
      executor_failure_kind: 'retry',
      executor_error_kind: 'provider',
      executor_possibly_dispatched: false,
    });
    expect((await harness.connection(connection.id)).status).toBe('active');
  });

  // Answer table: outage rows: unchanged, blocked 15 s, retry provider.
  it.each([['503'], ['server-error'], ['temporarily-unavailable']])(
    'a token address answering %s gives the endpoint-unavailable row',
    async (behavior) => {
      const connection = await harness.connected(owner, 'non-rotating');
      harness.standIn.setBehavior(connection.clientId, behavior);
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, {
        ...get(connection),
        retry: ONE_ATTEMPT,
      });
      await harness.finish(runId);
      const [attempt] = await harness.attempts(runId);
      expect(attempt).toMatchObject({
        safe_error_code: 'http.oauth2_token_endpoint_unavailable',
        error_summary: "The service's token address didn't answer.",
        executor_failure_kind: 'retry',
        executor_error_kind: 'provider',
        executor_possibly_dispatched: false,
      });
      expect((await harness.connection(connection.id)).status).toBe('active');
      expect(apiCalls(connection)).toBe(0);
      const [blocked] = await harness.stack.sql<{ seconds: number }>(
        `select extract(epoch from refresh_blocked_until - clock_timestamp()) as seconds
         from app.connection_oauth2_tokens where connection_id=$1`,
        [connection.id],
      );
      expect(blocked?.seconds).toBeGreaterThan(0);
      expect(blocked?.seconds).toBeLessThanOrEqual(15);
    },
  );

  // Answer table: a network failure is also endpoint-unavailable.
  it('a token address nobody listens on gives the endpoint-unavailable row', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.setTokenUrl(connection.id, 'http://127.0.0.1:1/token');
    await harness.expireToken(connection.id);
    const runId = await harness.run(owner, {
      ...get(connection),
      retry: ONE_ATTEMPT,
    });
    await harness.finish(runId);
    const [attempt] = await harness.attempts(runId);
    expect(attempt?.safe_error_code).toBe(
      'http.oauth2_token_endpoint_unavailable',
    );
    expect((await harness.connection(connection.id)).status).toBe('active');
  });

  // Answer table: 429: unchanged, blocked for Retry-After, retry rate_limit with that delay.
  it('a token address answering 429 gives the rate-limited row', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    harness.standIn.setBehavior(connection.clientId, '429');
    await harness.expireToken(connection.id);
    const runId = await harness.run(owner, {
      ...get(connection),
      retry: ONE_ATTEMPT,
    });
    await harness.finish(runId);
    const [attempt] = await harness.attempts(runId);
    expect(attempt).toMatchObject({
      safe_error_code: 'http.oauth2_token_rate_limited',
      error_summary: "The service's token address asked Pertexo to slow down.",
      executor_failure_kind: 'retry',
      executor_error_kind: 'rate_limit',
      executor_retry_after_millis: OAUTH2_STAND_IN_RETRY_AFTER_SECONDS * 1_000,
      executor_possibly_dispatched: false,
    });
    expect((await harness.connection(connection.id)).status).toBe('active');
    const [blocked] = await harness.stack.sql<{ seconds: number }>(
      `select extract(epoch from refresh_blocked_until - clock_timestamp()) as seconds
         from app.connection_oauth2_tokens where connection_id=$1`,
      [connection.id],
    );
    expect(blocked?.seconds).toBeGreaterThan(0);
    expect(blocked?.seconds).toBeLessThanOrEqual(
      OAUTH2_STAND_IN_RETRY_AFTER_SECONDS,
    );
  });

  // Answer table, S25-S27: unusable answers: unchanged, blocked 15 s, retry provider.
  it.each([
    'redirect',
    'oversized',
    'not-json',
    'no-access-token',
    'long-access-token',
    'long-refresh-token',
    'mac',
    'teapot',
    'unknown-error',
  ])(
    'a token address answering %s gives the invalid-response row',
    async (behavior) => {
      const connection = await harness.connected(owner, 'non-rotating');
      harness.standIn.setBehavior(connection.clientId, behavior);
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, {
        ...get(connection),
        retry: ONE_ATTEMPT,
      });
      await harness.finish(runId);
      const [attempt] = await harness.attempts(runId);
      expect(attempt).toMatchObject({
        safe_error_code: 'http.oauth2_token_response_invalid',
        error_summary:
          "The service's token address gave an answer Pertexo can't use. Check the token URL.",
        executor_failure_kind: 'retry',
        executor_error_kind: 'provider',
        executor_possibly_dispatched: false,
      });
      expect(apiCalls(connection)).toBe(0);
      expect((await harness.connection(connection.id)).status).toBe('active');
    },
  );

  // Answer table: invalid_grant loses the grant.
  it.each(['invalid-grant', 'error-200'])(
    'a token address answering %s gives the grant-revoked row',
    async (behavior) => {
      const connection = await harness.connected(owner, 'non-rotating');
      harness.standIn.setBehavior(connection.clientId, behavior);
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('failed');
      const attempts = await harness.attempts(runId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        safe_error_code: 'http.oauth2_grant_revoked',
        error_summary:
          "The service no longer accepts this connection's sign-in. Reconnect it in Connections.",
        executor_failure_kind: 'failed',
        executor_error_kind: 'authentication',
        executor_possibly_dispatched: false,
      });
      expect(await harness.connection(connection.id)).toMatchObject({
        status: 'reauthorization_required',
        last_error_code: 'connection.oauth2_grant_revoked',
      });
      expect(await harness.tokenRow(connection.id)).toBeUndefined();
      expect(apiCalls(connection)).toBe(0);
    },
  );

  // Answer table: invalid_client, unauthorized_client, invalid_scope, unsupported_grant_type.
  it.each([
    'invalid-client',
    'unauthorized-client',
    'invalid-scope',
    'unsupported-grant-type',
  ])(
    'a token address answering %s gives the client-rejected row',
    async (behavior) => {
      const connection = await harness.connected(owner, 'non-rotating');
      harness.standIn.setBehavior(connection.clientId, behavior);
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('failed');
      const attempts = await harness.attempts(runId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        safe_error_code: 'http.oauth2_client_rejected',
        error_summary:
          'The service refused the client ID or secret. Replace them in Connections, then reconnect.',
        executor_failure_kind: 'failed',
        executor_error_kind: 'authentication',
        executor_possibly_dispatched: false,
      });
      expect(await harness.connection(connection.id)).toMatchObject({
        status: 'reauthorization_required',
        last_error_code: 'connection.oauth2_client_rejected',
      });
      expect(await harness.tokenRow(connection.id)).toBeUndefined();
    },
  );

  // S26: bearer in any case, or absent, is usable.
  it('S26 a token with no token_type works', async () => {
    const connection = await harness.connected(owner, 'no-token-type');
    const runId = await harness.run(owner, get(connection));
    expect((await harness.finish(runId)).status).toBe('succeeded');
    expect(apiCalls(connection)).toBe(1);
  });

  // S25: exactly at the limits is accepted.
  it('S25 tokens exactly at their limits work', async () => {
    const connection = await harness.connected(owner, 'at-limit');
    const runId = await harness.run(owner, get(connection));
    expect((await harness.finish(runId)).status).toBe('succeeded');
    const [call] = harness.standIn.apiCalls(connection.clientId);
    expect(call?.headers.authorization).toBe(`Bearer ${'a'.repeat(8_000)}`);
  });

  // Constants: a block after a temporary failure is Retry-After, up to 60 s.
  it('a Retry-After over a minute blocks for a minute', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    harness.standIn.setBehavior(connection.clientId, '429');
    harness.standIn.setRetryAfter(connection.clientId, 3_600);
    await harness.expireToken(connection.id);
    const runId = await harness.run(owner, {
      ...get(connection),
      retry: ONE_ATTEMPT,
    });
    await harness.finish(runId);
    const [blocked] = await harness.stack.sql<{ seconds: number }>(
      `select extract(epoch from refresh_blocked_until - clock_timestamp()) as seconds
         from app.connection_oauth2_tokens where connection_id=$1`,
      [connection.id],
    );
    expect(blocked?.seconds).toBeGreaterThan(0);
    expect(blocked?.seconds).toBeLessThanOrEqual(60);
  });

  // Constants, answer table: the request gives up after 15 s, as an unavailable service.
  it('a token address that never answers times out at 15 seconds', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.expireToken(connection.id);
    const hold = harness.standIn.holdNextToken(connection.clientId);
    const runId = await harness.run(owner, {
      ...get(connection),
      retry: ONE_ATTEMPT,
    });
    try {
      await hold.arrived;
      const started = Date.now();
      await harness.finish(runId);
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      hold.release();
    }
    const [attempt] = await harness.attempts(runId);
    expect(attempt?.safe_error_code).toBe(
      'http.oauth2_token_endpoint_unavailable',
    );
    expect((await harness.connection(connection.id)).status).toBe('active');
  });

  // Answer table: a name that doesn't resolve is also endpoint-unavailable.
  it('a token address whose name doesn’t resolve gives the unavailable row', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.setTokenUrl(
      connection.id,
      'http://no-such-name.invalid/token',
    );
    await harness.expireToken(connection.id);
    const runId = await harness.run(owner, {
      ...get(connection),
      retry: ONE_ATTEMPT,
    });
    await harness.finish(runId);
    const [attempt] = await harness.attempts(runId);
    expect(attempt?.safe_error_code).toBe(
      'http.oauth2_token_endpoint_unavailable',
    );
    expect((await harness.connection(connection.id)).status).toBe('active');
  });
});
