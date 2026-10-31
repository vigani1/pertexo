import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import {
  OAUTH2_STAND_IN_DESCRIPTION,
  OAUTH2_STAND_IN_PAGES,
  OAUTH2_STAND_IN_RESPONSE_LIMIT_BYTES,
  OAUTH2_STAND_IN_RETRY_AFTER_SECONDS,
  startOAuth2StandIn,
} from './oauth2-stand-in.mjs';

const REDIRECT_URI = 'http://localhost:5999/v1/connections/oauth2/callback';
const VERIFIER = 'a-verifier-of-enough-length-for-this-test-0123456789';

describe('the OAuth2 stand-in', () => {
  let standIn;

  before(async () => {
    standIn = await startOAuth2StandIn();
  });
  after(async () => {
    await standIn.close();
  });

  const basic = (id, secret) =>
    `Basic ${Buffer.from(
      `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`,
    ).toString('base64')}`;

  const postToken = (clientId, form, headers = {}, secret = 'secret') =>
    fetch(`${standIn.origin}/token`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(clientId, secret),
        ...headers,
      },
      body: new URLSearchParams(form).toString(),
    });

  /** Runs consent as a browser would, returning where the provider sends it. */
  const consent = async (clientId, decision = 'approve', extra = {}) => {
    const fields = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'the-state',
      ...extra,
    };
    const page = await fetch(
      `${standIn.origin}/authorize?${new URLSearchParams(fields).toString()}`,
    );
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, />Approve</u);
    assert.match(html, />Deny</u);
    const decided = await fetch(`${standIn.origin}/authorize/decide`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, decision }).toString(),
    });
    assert.equal(decided.status, 302);
    return new URL(decided.headers.get('location'));
  };

  const exchange = async (clientId) => {
    const callback = await consent(clientId);
    const response = await postToken(clientId, {
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code'),
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const refresh = (clientId, refreshToken) =>
    postToken(clientId, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

  const callApi = (accessToken, path = '/api', method = 'GET') =>
    fetch(`${standIn.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}` },
    });

  it('approves with a code and the state, and denies without one', async () => {
    const clientId = standIn.newClient('non-rotating');
    const approved = await consent(clientId);
    assert.equal(approved.searchParams.get('state'), 'the-state');
    assert.ok(approved.searchParams.get('code'));
    const denied = await consent(clientId, 'deny');
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal(
      denied.searchParams.get('error_description'),
      OAUTH2_STAND_IN_DESCRIPTION,
    );
    assert.equal(denied.searchParams.get('code'), null);
    assert.equal(
      (await consent(clientId, 'error:server_error')).searchParams.get('error'),
      'server_error',
    );
  });

  it('exchanges a code once, and only with the same redirect address', async () => {
    const clientId = standIn.newClient('non-rotating');
    const code = (await consent(clientId)).searchParams.get('code');
    const wrong = await postToken(clientId, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://elsewhere.example.test/callback',
    });
    assert.equal(wrong.status, 400);
    const form = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    };
    assert.equal((await postToken(clientId, form)).status, 200);
    const replay = await postToken(clientId, form);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_grant');
  });

  it('checks the PKCE verifier against the challenge', async () => {
    const clientId = standIn.newClient('non-rotating');
    const code_challenge = createHash('sha256')
      .update(VERIFIER)
      .digest('base64url');
    const form = async (verifier) => ({
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code: (
        await consent(clientId, 'approve', {
          code_challenge,
          code_challenge_method: 'S256',
        })
      ).searchParams.get('code'),
      ...(verifier === undefined ? {} : { code_verifier: verifier }),
    });
    assert.equal(
      (await postToken(clientId, await form(undefined))).status,
      400,
    );
    assert.equal((await postToken(clientId, await form('wrong'))).status, 400);
    assert.equal((await postToken(clientId, await form(VERIFIER))).status, 200);
  });

  it('refuses a verifier when no challenge was sent', async () => {
    const clientId = standIn.newClient('non-rotating');
    const code = (await consent(clientId)).searchParams.get('code');
    const response = await postToken(clientId, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
    });
    assert.equal(response.status, 400);
  });

  it('reads basic authentication as RFC 6749 encodes it, and body authentication', async () => {
    const clientId = standIn.newClient('non-rotating');
    const secret = 'a+secret/with=marks';
    standIn.expectSecret(clientId, secret);
    const grant = { grant_type: 'client_credentials' };
    assert.equal(
      (await postToken(clientId, grant, {}, secret)).status,
      200,
      'form-encoded basic passes',
    );
    const raw = await fetch(`${standIn.origin}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      },
      body: new URLSearchParams(grant).toString(),
    });
    assert.equal(raw.status, 401, 'a + left unencoded reads as a space');
    const inBody = await fetch(`${standIn.origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...grant,
        client_id: clientId,
        client_secret: secret,
      }).toString(),
    });
    assert.equal(inBody.status, 200);
    const seen = standIn
      .tokenRequests(clientId)
      .map(({ authentication }) => authentication.method);
    assert.deepEqual(seen, ['basic', 'basic', 'body']);
    assert.equal(
      (await postToken(clientId, grant, {}, 'not-the-secret')).status,
      401,
    );
  });

  it('rotates with reuse detection: a second use revokes the whole family', async () => {
    const clientId = standIn.newClient('rotating-reuse');
    const first = await exchange(clientId);
    const second = await (await refresh(clientId, first.refresh_token)).json();
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.equal((await callApi(second.access_token)).status, 200);
    const reuse = await refresh(clientId, first.refresh_token);
    assert.equal((await reuse.json()).error, 'invalid_grant');
    assert.equal(
      (await (await refresh(clientId, second.refresh_token)).json()).error,
      'invalid_grant',
      "the winner's refresh token is revoked too",
    );
    assert.equal((await callApi(second.access_token)).status, 401);
  });

  it('rotates without detection: a late use fails and the new tokens live', async () => {
    const clientId = standIn.newClient('rotating');
    const first = await exchange(clientId);
    const second = await (await refresh(clientId, first.refresh_token)).json();
    const late = await refresh(clientId, first.refresh_token);
    assert.equal((await late.json()).error, 'invalid_grant');
    assert.equal((await callApi(second.access_token)).status, 200);
    const third = await refresh(clientId, second.refresh_token);
    assert.equal(third.status, 200);
  });

  it('keeps one refresh token when it does not rotate, and omits it from the answer', async () => {
    const clientId = standIn.newClient('non-rotating');
    const first = await exchange(clientId);
    for (const attempt of [1, 2]) {
      const answer = await (
        await refresh(clientId, first.refresh_token)
      ).json();
      assert.ok(answer.access_token, `attempt ${String(attempt)}`);
      assert.equal(answer.refresh_token, undefined);
    }
  });

  it('gives no refresh token and no expiry when told', async () => {
    const noRefresh = await exchange(standIn.newClient('no-refresh'));
    assert.equal(noRefresh.refresh_token, undefined);
    assert.equal(noRefresh.expires_in, 3_600);
    const noExpiry = await exchange(standIn.newClient('no-expiry'));
    assert.equal(noExpiry.expires_in, undefined);
    assert.equal(noExpiry.refresh_token, undefined);
  });

  it('never gives a refresh token to client credentials', async () => {
    const clientId = standIn.newClient('rotating');
    const answer = await (
      await postToken(clientId, { grant_type: 'client_credentials' })
    ).json();
    assert.ok(answer.access_token);
    assert.equal(answer.refresh_token, undefined);
  });

  it('answers late when delayed', async () => {
    const clientId = standIn.newClient('delayed');
    const started = Date.now();
    await postToken(clientId, { grant_type: 'client_credentials' });
    assert.ok(Date.now() - started >= 1_400);
  });

  it('holds a token request until released', async () => {
    const clientId = standIn.newClient('non-rotating');
    const hold = standIn.holdNextToken(clientId);
    let answered = false;
    const pending = postToken(clientId, {
      grant_type: 'client_credentials',
    }).then((response) => {
      answered = true;
      return response;
    });
    await hold.arrived;
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    assert.equal(answered, false);
    hold.release();
    assert.equal((await pending).status, 200);
  });

  const failing = [
    ['503', 503, undefined],
    ['429', 429, undefined],
    ['invalid-grant', 400, 'invalid_grant'],
    ['invalid-client', 401, 'invalid_client'],
    ['unauthorized-client', 400, 'unauthorized_client'],
    ['invalid-scope', 400, 'invalid_scope'],
    ['unsupported-grant-type', 400, 'unsupported_grant_type'],
    ['server-error', 503, 'server_error'],
    ['temporarily-unavailable', 503, 'temporarily_unavailable'],
    ['unknown-error', 400, 'stand_in_unknown_error'],
    ['error-200', 200, 'invalid_grant'],
    ['teapot', 418, undefined],
  ];
  for (const [behavior, status, error] of failing)
    it(`answers ${behavior} with status ${String(status)}`, async () => {
      const clientId = standIn.newClient(behavior);
      const response = await postToken(clientId, {
        grant_type: 'client_credentials',
      });
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.error, error);
      assert.equal(body.access_token, undefined);
    });

  it('gives Retry-After with a 429', async () => {
    const response = await postToken(standIn.newClient('429'), {
      grant_type: 'client_credentials',
    });
    assert.equal(
      response.headers.get('retry-after'),
      String(OAUTH2_STAND_IN_RETRY_AFTER_SECONDS),
    );
  });

  it('gives the Retry-After it is told', async () => {
    const clientId = standIn.newClient('429');
    standIn.setRetryAfter(clientId, 3_600);
    const response = await postToken(clientId, {
      grant_type: 'client_credentials',
    });
    assert.equal(response.headers.get('retry-after'), '3600');
  });

  it('redirects the token request, and records what reaches the target', async () => {
    const before = standIn.redirectTargetRequests().length;
    const response = await postToken(standIn.newClient('redirect'), {
      grant_type: 'client_credentials',
    });
    assert.equal(response.status, 302);
    const target = response.headers.get('location');
    assert.equal(target, `${standIn.origin}/redirect-target`);
    assert.equal(standIn.redirectTargetRequests().length, before);
    await fetch(target, { method: 'POST', body: 'followed' });
    const [last] = standIn.redirectTargetRequests().slice(-1);
    assert.equal(last.body, 'followed');
  });

  it('answers over the size limit when oversized', async () => {
    const response = await postToken(standIn.newClient('oversized'), {
      grant_type: 'client_credentials',
    });
    const body = await response.text();
    assert.ok(Buffer.byteLength(body) > OAUTH2_STAND_IN_RESPONSE_LIMIT_BYTES);
  });

  it('answers with tokens exactly at their limits', async () => {
    const answer = await exchange(standIn.newClient('at-limit'));
    assert.equal(answer.access_token.length, 8_000);
    assert.equal(answer.refresh_token.length, 16_384);
  });

  it('answers tokens over their limits', async () => {
    const access = await (
      await postToken(standIn.newClient('long-access-token'), {
        grant_type: 'client_credentials',
      })
    ).json();
    assert.equal(access.access_token.length, 8_001);
    const refreshing = await exchange(standIn.newClient('long-refresh-token'));
    assert.equal(refreshing.refresh_token.length, 16_385);
  });

  it('answers HTML when not JSON', async () => {
    const response = await postToken(standIn.newClient('not-json'), {
      grant_type: 'client_credentials',
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.throws(() => JSON.parse(body));
  });

  const tokenShapes = [
    ['mac', (answer) => answer.token_type === 'mac'],
    ['no-token-type', (answer) => answer.token_type === undefined],
    ['no-access-token', (answer) => answer.access_token === undefined],
    ['expires-string', (answer) => answer.expires_in === '3600'],
    ['expires-bad', (answer) => answer.expires_in === 'soon'],
  ];
  for (const [behavior, holds] of tokenShapes)
    it(`shapes the answer for ${behavior}`, async () => {
      const answer = await (
        await postToken(standIn.newClient(behavior), {
          grant_type: 'client_credentials',
        })
      ).json();
      assert.equal(holds(answer), true);
      assert.ok(answer.id_token, 'always offers an id_token to be ignored');
    });

  it('checks the bearer token on /api and counts the calls', async () => {
    const clientId = standIn.newClient('non-rotating');
    const { access_token } = await exchange(clientId);
    assert.equal((await callApi(access_token)).status, 200);
    assert.equal((await callApi('not-a-token')).status, 401);
    assert.equal(standIn.apiCalls(clientId).length, 1);
    const head = await callApi(access_token, '/api', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(standIn.apiCalls(clientId).length, 2);
  });

  it('never accepts a token after the service revokes the grant', async () => {
    const clientId = standIn.newClient('non-rotating');
    const { access_token, refresh_token } = await exchange(clientId);
    standIn.revoke(clientId);
    assert.equal((await callApi(access_token)).status, 401);
    assert.equal(
      (await (await refresh(clientId, refresh_token)).json()).error,
      'invalid_grant',
    );
    await exchange(clientId);
  });

  it('answers /api 401 every time when told', async () => {
    const clientId = standIn.newClient('api-401');
    const { access_token } = await exchange(clientId);
    for (const _ of [1, 2, 3])
      assert.equal((await callApi(access_token)).status, 401);
    assert.equal(standIn.apiCalls(clientId).length, 3);
  });

  it('answers /api 401 once, then succeeds', async () => {
    const clientId = standIn.newClient('api-401-once');
    const { access_token } = await exchange(clientId);
    assert.equal((await callApi(access_token)).status, 401);
    assert.equal((await callApi(access_token)).status, 200);
  });

  it('answers /api 403 when told', async () => {
    const { access_token } = await exchange(standIn.newClient('api-403'));
    assert.equal((await callApi(access_token)).status, 403);
  });

  it('pages /api/pages and answers 401 once on page 3 when told', async () => {
    const { access_token } = await exchange(
      standIn.newClient('api-401-page-3'),
    );
    const page = (number) => callApi(access_token, `/api/pages?page=${number}`);
    assert.equal((await page(2)).status, 200);
    assert.equal((await page(3)).status, 401);
    const third = await (await page(3)).json();
    assert.deepEqual(third.items, [{ id: 3 }]);
    assert.ok(third.next.endsWith('page=4'));
    const last = await (await page(OAUTH2_STAND_IN_PAGES)).json();
    assert.equal(last.next, null);
  });

  it('changes behavior when told, and scripts single answers first', async () => {
    const clientId = standIn.newClient('non-rotating');
    const { refresh_token } = await exchange(clientId);
    assert.equal((await refresh(clientId, refresh_token)).status, 200);
    standIn.setBehavior(clientId, '503');
    assert.equal((await refresh(clientId, refresh_token)).status, 503);
    standIn.setBehavior(clientId, 'non-rotating');
    standIn.scriptAnswers(clientId, ['429']);
    assert.equal((await refresh(clientId, refresh_token)).status, 429);
    assert.equal((await refresh(clientId, refresh_token)).status, 200);
  });

  it('accepts a replaced refresh token when told, and records what it issued', async () => {
    const clientId = standIn.newClient('rotating');
    const first = await exchange(clientId);
    standIn.acceptAnyRefresh(clientId);
    const renewed = await (await refresh(clientId, first.refresh_token)).json();
    const late = await refresh(clientId, first.refresh_token);
    assert.equal(late.status, 200);
    const [, second] = standIn.tokenRequests(clientId);
    assert.equal(second.issued.accessToken, renewed.access_token);
    assert.equal(second.issued.refreshToken, renewed.refresh_token);
  });

  it('gives a lifetime inside the renewal window when short-lived', async () => {
    const answer = await exchange(standIn.newClient('short-lived'));
    assert.equal(answer.expires_in, 30);
    assert.ok(answer.refresh_token);
  });

  it('sets a short lifetime when told', async () => {
    const clientId = standIn.newClient('non-rotating');
    standIn.setExpiresIn(clientId, 30);
    assert.equal((await exchange(clientId)).expires_in, 30);
  });

  it('answers its control routes over HTTP, for a browser test', async () => {
    const clientId = standIn.newClient('non-rotating');
    const { access_token } = await exchange(clientId);
    await callApi(access_token);
    const counts = await fetch(
      `${standIn.origin}/control/requests?clientId=${encodeURIComponent(clientId)}`,
    );
    assert.deepEqual(await counts.json(), { token: 1, api: 1 });
    const revoked = await fetch(`${standIn.origin}/control/revoke`, {
      method: 'POST',
      body: JSON.stringify({ clientId }),
    });
    assert.equal(revoked.status, 200);
    assert.equal((await callApi(access_token)).status, 401);
  });

  it('really goes down when closed', async () => {
    const other = await startOAuth2StandIn();
    const { origin } = other;
    assert.equal((await fetch(`${origin}/`)).status, 200);
    await other.close();
    await assert.rejects(fetch(`${origin}/`));
  });
});
