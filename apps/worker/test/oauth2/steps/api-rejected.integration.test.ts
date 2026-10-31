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

describeOAuth2('an API that refuses an OAuth2 token', () => {
  let harness: OAuth2Harness;
  let owner: Owner;

  beforeAll(async () => {
    harness = await startOAuth2Harness('steps-api-rejected');
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

  // L11: GET and HEAD with 401-once succeed with 2 /api calls and 1 token request.
  it.each(['GET', 'HEAD'] as const)(
    'L11 a %s that gets a 401 renews and repeats once',
    async (method) => {
      const connection = await harness.connected(owner, 'api-401-once');
      await harness.ageToken(connection.id);
      const exchanged = tokenCalls(connection);
      const runId = await harness.run(owner, get(connection, { method }));
      expect((await harness.finish(runId)).status).toBe('succeeded');
      expect(apiCalls(connection)).toBe(2);
      expect(tokenCalls(connection)).toBe(exchanged + 1);
      const calls = harness.standIn.apiCalls(connection.clientId);
      expect(calls[0]?.headers.authorization).not.toBe(
        calls[1]?.headers.authorization,
      );
      // One attempt did all of it, and the body of the 401 wasn't kept.
      expect(await harness.attempts(runId)).toHaveLength(1);
      expect(await harness.storedOutput(runId)).not.toContain('invalid_token');
    },
  );

  // L12: the plan's own proof that a retry never repeats a side effect.
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'L12 a %s that gets a 401 is never sent twice',
    async (method) => {
      const connection = await harness.connected(owner, 'api-401-once');
      await harness.ageToken(connection.id);
      const tokenBefore = await harness.tokenRow(connection.id);
      const exchanged = tokenCalls(connection);
      const runId = await harness.run(owner, get(connection, { method }));
      expect((await harness.finish(runId)).status).toBe('failed');
      // Exactly one call, whatever the attempts. This is the whole point of L12.
      expect(apiCalls(connection)).toBe(1);
      expect(harness.standIn.apiCalls(connection.clientId)[0]?.method).toBe(
        method,
      );
      expect(tokenCalls(connection)).toBe(exchanged);
      const attempts = await harness.attempts(runId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        executor_error_kind: 'authentication',
        executor_possibly_dispatched: true,
      });
      // Marked for renewal: its expiry is now, on the same version.
      const tokenAfter = await harness.tokenRow(connection.id);
      expect(tokenAfter?.id).toBe(tokenBefore?.id);
      expect(
        tokenAfter?.access_token_expires_at?.getTime(),
      ).toBeLessThanOrEqual(Date.now() + 1_000);
      expect((await harness.connection(connection.id)).status).toBe('active');
    },
  );

  // L12: "The next attempt started by a person or a run picks up the new token."
  it('L12 the next run after a rejected POST uses a new token', async () => {
    const connection = await harness.connected(owner, 'api-401-once');
    await harness.ageToken(connection.id);
    const first = await harness.run(owner, get(connection, { method: 'POST' }));
    expect((await harness.finish(first)).status).toBe('failed');
    const second = await harness.run(
      owner,
      get(connection, { method: 'POST' }),
    );
    expect((await harness.finish(second)).status).toBe('succeeded');
    const calls = harness.standIn.apiCalls(connection.clientId);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.authorization).not.toBe(
      calls[1]?.headers.authorization,
    );
  });

  // L13: a token younger than 60 s can't be rejected, so a GET fails with no repeat.
  it('L13 a young token isn’t renewed by a 401', async () => {
    const connection = await harness.connected(owner, 'api-401');
    const tokenBefore = await harness.tokenRow(connection.id);
    const exchanged = tokenCalls(connection);
    const runId = await harness.run(owner, {
      ...get(connection),
      retry: ONE_ATTEMPT,
    });
    expect((await harness.finish(runId)).status).toBe('failed');
    expect(apiCalls(connection)).toBe(1);
    expect(tokenCalls(connection)).toBe(exchanged);
    expect((await harness.tokenRow(connection.id))?.id).toBe(tokenBefore?.id);
  });

  // L13: not renewable, so marking does nothing and a GET fails without repeating.
  it('L13 a token that can’t be renewed isn’t marked by a 401', async () => {
    const connection = await harness.connected(owner, 'no-refresh');
    harness.standIn.setBehavior(connection.clientId, 'api-401');
    await harness.ageToken(connection.id);
    const before = await harness.tokenRow(connection.id);
    const runId = await harness.run(owner, {
      ...get(connection),
      retry: ONE_ATTEMPT,
    });
    expect((await harness.finish(runId)).status).toBe('failed');
    expect(apiCalls(connection)).toBe(1);
    expect(
      (await harness.tokenRow(connection.id))?.access_token_expires_at,
    ).toEqual(before?.access_token_expires_at);
    expect((await harness.connection(connection.id)).status).toBe('active');
  });

  // L13: an always-401 GET makes at most one renewal per 60 s, across several runs.
  it('L13 an always-401 GET can’t drive refreshes', async () => {
    const connection = await harness.connected(owner, 'api-401');
    await harness.ageToken(connection.id);
    const exchanged = tokenCalls(connection);
    for (const _ of [1, 2, 3]) {
      const runId = await harness.run(owner, {
        ...get(connection),
        retry: ONE_ATTEMPT,
      });
      expect((await harness.finish(runId)).status).toBe('failed');
    }
    expect(tokenCalls(connection)).toBe(exchanged + 1);
    expect((await harness.connection(connection.id)).status).toBe('active');
  });

  // L14: after a repeat, a second 401 fails.
  it('L14 a second 401 after a repeat fails the GET', async () => {
    const connection = await harness.connected(owner, 'api-401');
    await harness.ageToken(connection.id);
    const runId = await harness.run(owner, {
      ...get(connection),
      retry: ONE_ATTEMPT,
    });
    expect((await harness.finish(runId)).status).toBe('failed');
    expect(apiCalls(connection)).toBe(2);
    const [attempt] = await harness.attempts(runId);
    expect(attempt?.executor_error_kind).toBe('authentication');
  });

  // L14: a paged GET with a 401 on page 3 repeats only page 3, with dispatch marked once.
  it('L14 a paged GET repeats only the page that got a 401', async () => {
    const connection = await harness.connected(owner, 'api-401-page-3');
    await harness.ageToken(connection.id);
    const runId = await harness.run(owner, {
      ...get(connection, { url: harness.apiUrl('/api/pages?page=1') }),
      pagination: {
        mode: 'next_link',
        source: { kind: 'body', path: '$.next' },
        itemsPath: '$.items',
        maxPages: 10,
        delayMillis: 0,
      },
    });
    expect((await harness.finish(runId)).status).toBe('succeeded');
    const pages = harness.standIn
      .apiCalls(connection.clientId)
      .map(({ query }) => Number(query.page));
    expect(pages).toEqual([1, 2, 3, 3, 4]);
    const attempts = await harness.attempts(runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.dispatch_marked_at).not.toBeNull();
  });

  // L15: after any 401 or 403 the connection is still active.
  it.each(['api-401', 'api-401-once', 'api-403'])(
    'L15 an API answering %s never changes the connection',
    async (behavior) => {
      const connection = await harness.connected(owner, behavior);
      await harness.ageToken(connection.id);
      const revisionBefore = (await harness.connection(connection.id))
        .health_revision;
      const runId = await harness.run(owner, {
        ...get(connection, { method: 'POST' }),
        retry: ONE_ATTEMPT,
      });
      await harness.finish(runId);
      expect(await harness.connection(connection.id)).toMatchObject({
        status: 'active',
        last_error_code: null,
        health_revision: revisionBefore,
      });
      expect(await harness.tokenRow(connection.id)).toBeDefined();
    },
  );

  // L15: 403 never renews.
  it('L15 a 403 never renews', async () => {
    const connection = await harness.connected(owner, 'api-403');
    await harness.ageToken(connection.id);
    const before = await harness.tokenRow(connection.id);
    const exchanged = tokenCalls(connection);
    const runId = await harness.run(owner, {
      ...get(connection),
      retry: ONE_ATTEMPT,
    });
    expect((await harness.finish(runId)).status).toBe('failed');
    expect(apiCalls(connection)).toBe(1);
    expect(tokenCalls(connection)).toBe(exchanged);
    expect(
      (await harness.tokenRow(connection.id))?.access_token_expires_at,
    ).toEqual(before?.access_token_expires_at);
  });
});
