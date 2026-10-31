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

describeOAuth2('what an OAuth2 step sends', () => {
  let harness: OAuth2Harness;
  let owner: Owner;

  beforeAll(async () => {
    harness = await startOAuth2Harness('steps-requests');
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

  const apiCalls = (connection: Connection): number =>
    harness.standIn.apiCalls(connection.clientId).length;

  // Proof list: reaches /api with Bearer <token>, and the token isn't in its output.
  it.fails(
    'calls the API with the bearer token and doesn’t store it',
    async () => {
      const connection = await harness.connected(owner, 'non-rotating');
      const runId = await harness.run(owner, get(connection));
      expect((await harness.finish(runId)).status).toBe('succeeded');
      const [call] = harness.standIn.apiCalls(connection.clientId);
      expect(call?.headers.authorization).toMatch(/^Bearer stand-in-at-/u);
      const token = String(call?.headers.authorization).slice('Bearer '.length);
      expect(await harness.storedOutput(runId)).not.toContain(token);
    },
  );

  // S24: a listed host passes; an unlisted one fails with no /api call.
  it.fails('S24 sends the token only to a listed host', async () => {
    const port = new URL(harness.standIn.origin).port;
    const connection = await harness.connected(owner, 'non-rotating', {
      requestHosts: { mode: 'listed', hosts: ['api.listed.example.test'] },
    });
    const allowed = await harness.run(owner, {
      ...get(connection, {
        url: `http://api.listed.example.test:${port}/api`,
      }),
    });
    expect((await harness.finish(allowed)).status).toBe('succeeded');
    expect(apiCalls(connection)).toBe(1);
    const refused = await harness.run(owner, {
      ...get(connection, { url: `http://other.example.test:${port}/api` }),
      retry: ONE_ATTEMPT,
    });
    expect((await harness.finish(refused)).status).toBe('failed');
    const [attempt] = await harness.attempts(refused);
    expect(attempt).toMatchObject({
      safe_error_code: 'http.oauth2_host_not_allowed',
      error_summary:
        "This connection can't send its token to that host. Change the URL or the connection's allowed hosts.",
      executor_failure_kind: 'failed',
      executor_error_kind: 'configuration',
      executor_possibly_dispatched: false,
    });
    expect(apiCalls(connection)).toBe(1);
    expect(
      harness.standIn.requests.filter(({ host }) =>
        host?.startsWith('other.example.test'),
      ),
    ).toEqual([]);
  });

  // S24: *.example.com matches subdomains, not the apex.
  it.fails('S24 a wildcard matches subdomains, not the apex', async () => {
    const port = new URL(harness.standIn.origin).port;
    const connection = await harness.connected(owner, 'non-rotating', {
      requestHosts: { mode: 'listed', hosts: ['*.listed.example.test'] },
    });
    const subdomain = await harness.run(
      owner,
      get(connection, { url: `http://api.listed.example.test:${port}/api` }),
    );
    expect((await harness.finish(subdomain)).status).toBe('succeeded');
    expect(apiCalls(connection)).toBe(1);
    const apex = await harness.run(owner, {
      ...get(connection, { url: `http://listed.example.test:${port}/api` }),
      retry: ONE_ATTEMPT,
    });
    expect((await harness.finish(apex)).status).toBe('failed');
    const [attempt] = await harness.attempts(apex);
    expect(attempt?.safe_error_code).toBe('http.oauth2_host_not_allowed');
    expect(apiCalls(connection)).toBe(1);
  });

  // Using it: a step can't set its own Authorization. Configured headers refuse that
  // name at save today, so the step never reaches a run.
  it.fails(
    'a step can’t set its own Authorization beside the token',
    async () => {
      const connection = await harness.connected(owner, 'non-rotating');
      await expect(
        harness.run(
          owner,
          get(connection, {
            headers: { Authorization: 'Bearer step-own-value' },
          }),
        ),
      ).rejects.toThrow(/API answered 4/u);
      expect(apiCalls(connection)).toBe(0);
    },
  );

  // Getting a token, step 1: "record the credential access once".
  it.fails('records one credential access for one use', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    const before = (await harness.events(connection.id)).filter(
      (type) => type === 'connection.credential_accessed',
    ).length;
    await harness.finish(await harness.run(owner, get(connection)));
    const after = (await harness.events(connection.id)).filter(
      (type) => type === 'connection.credential_accessed',
    ).length;
    expect(after - before).toBe(1);
  });

  // S27: Accept: application/json is always sent, on every token request.
  it.fails('S27 asks for JSON on every token request', async () => {
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.expireToken(connection.id);
    await harness.finish(await harness.run(owner, get(connection)));
    const requests = harness.standIn.tokenRequests(connection.clientId);
    expect(requests).toHaveLength(2);
    for (const { headers } of requests)
      expect(headers.accept).toBe('application/json');
  });

  // Decisions: basic by default, per RFC 6749 §2.3.1, with a secret that needs encoding.
  it.fails('basic authentication encodes a secret with + and /', async () => {
    const { standIn } = harness;
    const clientId = standIn.newClient('non-rotating');
    const clientSecret = 'a+secret/with=marks&more';
    standIn.expectSecret(clientId, clientSecret);
    const created = await harness.createResponse(
      owner,
      harness.settings(clientId, { clientAuthentication: 'basic' }),
      clientSecret,
    );
    expect(created.status).toBe(201);
    const { id } = created.json as { id: string };
    const url = harness.authorizationUrl(
      await harness.start(owner.api, owner, id),
    );
    const landing = await harness.land(
      owner.api,
      await harness.decide(url, 'approve'),
    );
    expect(landing.result).toBe('connected');
    const [exchange] = standIn.tokenRequests(clientId);
    expect(exchange?.authentication).toEqual({
      method: 'basic',
      clientId,
      clientSecret,
    });
    expect(exchange?.form?.client_secret).toBeUndefined();
    await harness.expireToken(id);
    const runId = await harness.run(owner, {
      connectionId: id,
      method: 'GET',
      url: harness.apiUrl(),
    });
    expect((await harness.finish(runId)).status).toBe('succeeded');
    expect(standIn.tokenRequests(clientId)[1]?.authentication?.method).toBe(
      'basic',
    );
  });

  // Decisions: the request body as an option, with the same secret.
  it.fails('body authentication sends the secret in the form', async () => {
    const { standIn } = harness;
    const clientId = standIn.newClient('non-rotating');
    const clientSecret = 'a+secret/with=marks&more';
    standIn.expectSecret(clientId, clientSecret);
    const created = await harness.createResponse(
      owner,
      harness.serverSettings(clientId, { clientAuthentication: 'body' }),
      clientSecret,
    );
    const { id } = created.json as { id: string };
    expect((await harness.start(owner.api, owner, id)).status).toBe(200);
    const [exchange] = standIn.tokenRequests(clientId);
    expect(exchange?.authentication).toEqual({
      method: 'body',
      clientId,
      clientSecret,
    });
    expect(exchange?.headers.authorization).toBeUndefined();
  });

  // Decisions: extra parameters reach the right request, and only that one.
  it.fails('extra parameters reach the right request', async () => {
    const connection = await harness.create(owner, 'non-rotating', {
      scope: 'one,two three',
      authorizationParameters: { access_type: 'offline', prompt: 'consent' },
      tokenParameters: { audience: 'https://api.example.com' },
    });
    const url = new URL(
      harness.authorizationUrl(
        await harness.start(owner.api, owner, connection.id),
      ),
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('audience')).toBeNull();
    expect(url.searchParams.get('scope')).toBe('one,two three');
    const landing = await harness.land(
      owner.api,
      await harness.decide(url.toString(), 'approve'),
    );
    expect(landing.result).toBe('connected');
    await harness.expireToken(connection.id);
    await harness.finish(await harness.run(owner, get(connection)));
    const requests = harness.standIn.tokenRequests(connection.clientId);
    expect(requests).toHaveLength(2);
    for (const { form } of requests) {
      expect(form?.audience).toBe('https://api.example.com');
      expect(form?.access_type).toBeUndefined();
    }
  });

  // Decisions: scope is sent as typed on a server-to-server token request.
  it.fails('client credentials sends the scope as typed', async () => {
    const connection = await harness.createServer(owner, 'non-rotating', {
      scope: 'one,two three',
    });
    await harness.start(owner.api, owner, connection.id);
    const [request] = harness.standIn.tokenRequests(connection.clientId);
    expect(request?.form?.scope).toBe('one,two three');
    expect(request?.form?.grant_type).toBe('client_credentials');
  });

  // Getting a token, D10: each refresh re-seals, under the row's new id.
  it.fails(
    'D10 a refresh re-seals the tokens under a new version',
    async () => {
      const connection = await harness.connected(owner, 'non-rotating');
      const read = async () =>
        (
          await harness.stack.sql<{ ciphertext: string; id: string }>(
            `select id, ciphertext from app.connection_oauth2_tokens where connection_id=$1`,
            [connection.id],
          )
        )[0];
      const before = await read();
      await harness.expireToken(connection.id);
      await harness.finish(await harness.run(owner, get(connection)));
      const after = await read();
      expect(after?.id).not.toBe(before?.id);
      expect(after?.ciphertext).not.toBe(before?.ciphertext);
    },
  );
});
