import { afterAll, beforeAll, expect, it } from 'vitest';
import { OAUTH2_STAND_IN_DESCRIPTION } from '../../../../../infrastructure/testing/oauth2-stand-in.mjs';
import {
  CALLBACK_PATH,
  describeOAuth2,
  startOAuth2Harness,
  WEB_ORIGIN,
  useOAuth2Timeouts,
  type Connection,
  type OAuth2Harness,
  type Owner,
} from '../../support/oauth2/harness.js';

useOAuth2Timeouts();

/** `identity_callback`'s limit per client address, in the rate limit policy. */
const CALLBACK_LIMIT = 30;

describeOAuth2('exchanging a code', () => {
  let harness: OAuth2Harness;

  beforeAll(async () => {
    harness = await startOAuth2Harness('consent-exchange');
  });
  afterAll(async () => {
    await harness.close();
  });

  /** A connection whose consent is pending, and the address the service would send back. */
  const pendingConsent = async (
    behavior = 'non-rotating',
  ): Promise<
    Readonly<{ owner: Owner; connection: Connection; callbackUrl: string }>
  > => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, behavior);
    const started = await harness.start(owner.api, owner, connection.id);
    const callbackUrl = await harness.decide(
      harness.authorizationUrl(started),
      'approve',
    );
    return { owner, connection, callbackUrl };
  };

  const expectNothingExchanged = (connection: Connection): void => {
    expect(harness.standIn.tokenRequests(connection.clientId)).toEqual([]);
  };

  // S9, proof list: access_denied lands denied and exchanges nothing.
  it('a denied first consent lands denied and stays unconnected', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const url = harness.authorizationUrl(
      await harness.start(owner.api, owner, connection.id),
    );
    const landing = await harness.land(
      owner.api,
      await harness.decide(url, 'deny'),
    );
    expect(landing).toMatchObject({
      result: 'denied',
      workspaceId: owner.workspaceId,
      connectionId: connection.id,
    });
    expectNothingExchanged(connection);
    expect(await harness.connection(connection.id)).toMatchObject({
      status: 'reauthorization_required',
      last_error_code: 'connection.oauth2_not_authorized',
    });
  });

  // S9, proof list: a cancelled reconnect breaks nothing: tokens stay in force.
  it('a denied reconnect leaves an active connection working', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    const tokenBefore = await harness.tokenRow(connection.id);
    const url = harness.authorizationUrl(
      await harness.start(owner.api, owner, connection.id),
    );
    const landing = await harness.land(
      owner.api,
      await harness.decide(url, 'deny'),
    );
    expect(landing.result).toBe('denied');
    expect((await harness.connection(connection.id)).status).toBe('active');
    expect((await harness.tokenRow(connection.id))?.id).toBe(tokenBefore?.id);
    const runId = await harness.run(owner, {
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(),
    });
    expect((await harness.finish(runId)).status).toBe('succeeded');
    expect(harness.standIn.apiCalls(connection.clientId)).toHaveLength(1);
  });

  // S9 (review): an outage at consent isn't a wrong client ID.
  it.each(['temporarily_unavailable', 'server_error'])(
    'S9 consent answering %s lands provider_unavailable',
    async (error) => {
      const owner = await harness.newOwner();
      const connection = await harness.create(owner, 'non-rotating');
      const url = harness.authorizationUrl(
        await harness.start(owner.api, owner, connection.id),
      );
      const landing = await harness.land(
        owner.api,
        await harness.decide(url, `error:${error}`),
      );
      expect(landing.result).toBe('provider_unavailable');
      expect(landing.location).not.toContain(OAUTH2_STAND_IN_DESCRIPTION);
      expectNothingExchanged(connection);
    },
  );

  // S1: "Every outcome is a landing page": a client secret that won't open is the
  // same unexpected failure as a key service or database going away.
  it('S1 an unexpected failure lands on provider_unavailable', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    await harness.stack.sql(
      `update app.connection_secret_versions set ciphertext='AAAA' where connection_id=$1`,
      [connection.id],
    );
    const landing = await harness.land(owner.api, callbackUrl);
    expect(landing.status).toBe(303);
    expect(landing).toMatchObject({
      result: 'provider_unavailable',
      workspaceId: owner.workspaceId,
      connectionId: connection.id,
    });
    expectNothingExchanged(connection);
  });

  // S1: the callback's rate limit is the other way a popup gets a JSON problem.
  it('S1 a rate-limited callback still lands on a page', async () => {
    const browser = harness.anonymousBrowser();
    const callback = `${WEB_ORIGIN}${CALLBACK_PATH}`;
    for (let sent = 0; sent < CALLBACK_LIMIT; sent += 1)
      expect((await harness.land(browser, callback)).status).toBe(303);
    const limited = await harness.land(browser, callback);
    expect(limited.status).toBe(303);
    expect(limited.result).toBe('provider_unavailable');
  });

  // S9: any other provider error lands token_refused, and its words are never kept.
  it('another provider error lands token_refused and keeps none of its words', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const url = harness.authorizationUrl(
      await harness.start(owner.api, owner, connection.id),
    );
    const callbackUrl = await harness.decide(url, 'error:invalid_scope');
    expect(new URL(callbackUrl).searchParams.get('error_description')).toBe(
      OAUTH2_STAND_IN_DESCRIPTION,
    );
    const landing = await harness.land(owner.api, callbackUrl);
    expect(landing.result).toBe('token_refused');
    expect(landing.location).not.toContain(OAUTH2_STAND_IN_DESCRIPTION);
    expectNothingExchanged(connection);
    const read = await harness.read(owner.api, owner, connection.id);
    expect(JSON.stringify(read.json)).not.toContain(
      OAUTH2_STAND_IN_DESCRIPTION,
    );
    expect(
      harness.stack.apiProcess.logs.some(({ text }) =>
        text.includes(OAUTH2_STAND_IN_DESCRIPTION),
      ),
    ).toBe(false);
  });

  // S9: a code is never retried: a 503 on exchange lands provider_unavailable once.
  it('a code is exchanged once, even when the exchange fails', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    harness.standIn.setBehavior(connection.clientId, '503');
    const landing = await harness.land(owner.api, callbackUrl);
    expect(landing.result).toBe('provider_unavailable');
    expect(harness.standIn.tokenRequests(connection.clientId)).toHaveLength(1);
    expect(await harness.connection(connection.id)).toMatchObject({
      status: 'reauthorization_required',
    });
  });

  // Landing table: a refusal at the token address lands token_refused.
  it.each([
    'invalid-grant',
    'invalid-client',
    'unauthorized-client',
    'invalid-scope',
    'unsupported-grant-type',
    'error-200',
    'not-json',
    'oversized',
    'mac',
    'redirect',
    'no-access-token',
  ])('a code exchange answered %s lands token_refused', async (behavior) => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    harness.standIn.setBehavior(connection.clientId, behavior);
    const landing = await harness.land(owner.api, callbackUrl);
    expect(landing).toMatchObject({
      result: 'token_refused',
      connectionId: connection.id,
    });
    expect((await harness.connection(connection.id)).status).toBe(
      'reauthorization_required',
    );
    expect(await harness.tokenRow(connection.id)).toBeUndefined();
  });

  // Landing table: an answer that says "come back later" lands provider_unavailable.
  it.each(['503', '429', 'server-error', 'temporarily-unavailable'])(
    'a code exchange answered %s lands provider_unavailable',
    async (behavior) => {
      const { owner, connection, callbackUrl } = await pendingConsent();
      harness.standIn.setBehavior(connection.clientId, behavior);
      expect((await harness.land(owner.api, callbackUrl)).result).toBe(
        'provider_unavailable',
      );
      expect(await harness.tokenRow(connection.id)).toBeUndefined();
    },
  );

  // S10: closing the tab doesn't lose a consumed code.
  it('S10 finishes the exchange after the tab closes', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const hold = harness.standIn.holdNextToken(connection.clientId);
    const closing = new AbortController();
    const landing = harness
      .land(owner.api, callbackUrl, undefined, closing.signal)
      .catch(() => 'closed');
    await hold.arrived;
    closing.abort();
    expect(await landing).toBe('closed');
    hold.release();
    await expect
      .poll(async () => (await harness.connection(connection.id)).status, {
        timeout: 15_000,
      })
      .toBe('active');
    expect(await harness.tokenRow(connection.id)).toBeDefined();
  });
});
