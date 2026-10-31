import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * The outside OAuth2 provider for tests: a real HTTP server that records every
 * request it receives. What a client ID does comes from the text before its
 * first dot, so `rotating-reuse.<anything>` is an isolated client of that kind.
 * A test can change a client's behavior later, which is how a healthy grant
 * starts failing.
 */
const OAUTH2_STAND_IN_BEHAVIORS = Object.freeze([
  'rotating-reuse',
  'rotating',
  'non-rotating',
  'no-refresh',
  'no-expiry',
  'short-lived',
  'delayed',
  '503',
  '429',
  'invalid-grant',
  'invalid-client',
  'unauthorized-client',
  'invalid-scope',
  'unsupported-grant-type',
  'server-error',
  'temporarily-unavailable',
  'unknown-error',
  'error-200',
  'redirect',
  'redirect-307',
  'oversized',
  'at-limit',
  'not-json',
  'mac',
  'no-token-type',
  'no-access-token',
  'long-access-token',
  'long-refresh-token',
  'teapot',
  'expires-string',
  'expires-bad',
  'api-401',
  'api-401-once',
  'api-401-page-3',
  'api-403',
]);

const DELAYED_MS = 1_500;
const BODY_LIMIT_BYTES = 1_048_576;
export const OAUTH2_STAND_IN_RESPONSE_LIMIT_BYTES = 65_536;
export const OAUTH2_STAND_IN_RETRY_AFTER_SECONDS = 7;
export const OAUTH2_STAND_IN_PAGES = 4;
/** A provider's own words, which Pertexo must never store or show. */
export const OAUTH2_STAND_IN_DESCRIPTION = 'stand-in-private-error-description';

const OAUTH_ERRORS = Object.freeze({
  'invalid-grant': 'invalid_grant',
  'invalid-client': 'invalid_client',
  'unauthorized-client': 'unauthorized_client',
  'invalid-scope': 'invalid_scope',
  'unsupported-grant-type': 'unsupported_grant_type',
  'server-error': 'server_error',
  'temporarily-unavailable': 'temporarily_unavailable',
  'unknown-error': 'stand_in_unknown_error',
});

const secretToken = (prefix) =>
  `${prefix}-${randomBytes(18).toString('base64url')}`;

const behaviorOfClient = (clientId) => {
  const prefix = clientId.split('.', 1)[0];
  return OAUTH2_STAND_IN_BEHAVIORS.includes(prefix) ? prefix : 'non-rotating';
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error('Stand-in request body is over its limit'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

/** RFC 6749 §2.3.1: both parts are form-encoded before Basic joins them. */
function clientFromBasicHeader(header) {
  if (!header?.toLowerCase().startsWith('basic ')) return undefined;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 0) return undefined;
  const part = (value) => decodeURIComponent(value.replaceAll('+', ' '));
  return {
    method: 'basic',
    clientId: part(decoded.slice(0, split)),
    clientSecret: part(decoded.slice(split + 1)),
  };
}

const json = (response, status, value, headers = {}) => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(value));
};

const authorizePage = (fields) => {
  const hidden = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><title>Stand-in consent</title></head><body>
<h1>Allow access?</h1>
<form method="post" action="/authorize/decide">${hidden}
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form></body></html>`;
};

export async function startOAuth2StandIn({
  host = '127.0.0.1',
  port = 0,
} = {}) {
  const requests = [];
  const clients = new Map();
  const codes = new Map();
  const tokens = new Map();
  const held = new Set();
  const openResponses = new Set();
  let origin = '';

  const clientState = (clientId) => {
    let state = clients.get(clientId);
    if (state === undefined) {
      state = {
        behavior: behaviorOfClient(clientId),
        secret: undefined,
        currentRefresh: undefined,
        usedRefresh: new Set(),
        revoked: false,
        tokenAnswers: 0,
        apiCalls: 0,
        api401Sent: false,
        // Always inside the 60 s renewal window, so each use really asks the service.
        expiresIn: behaviorOfClient(clientId) === 'short-lived' ? 30 : 3_600,
        holds: [],
        answers: [],
        acceptsAnyRefresh: false,
        retryAfterSeconds: OAUTH2_STAND_IN_RETRY_AFTER_SECONDS,
      };
      clients.set(clientId, state);
    }
    return state;
  };

  const issueAccess = (clientId) => {
    const accessToken = secretToken('stand-in-at');
    tokens.set(accessToken, { clientId, revoked: false });
    return accessToken;
  };

  const issueRefresh = (clientId) => {
    const refreshToken = secretToken('stand-in-rt');
    clientState(clientId).currentRefresh = refreshToken;
    return refreshToken;
  };

  const revokeFamily = (clientId) => {
    const state = clientState(clientId);
    state.revoked = true;
    state.currentRefresh = undefined;
    for (const token of tokens.values())
      if (token.clientId === clientId) token.revoked = true;
  };

  const tokenBody = (clientId, grantType) => {
    const { behavior, expiresIn } = clientState(clientId);
    const accessToken = issueAccess(clientId);
    const body = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      // Pertexo must ignore this: it is never stored.
      id_token: secretToken('stand-in-id'),
    };
    if (behavior === 'no-token-type') delete body.token_type;
    if (behavior === 'mac') body.token_type = 'mac';
    if (behavior === 'expires-string') body.expires_in = String(expiresIn);
    if (behavior === 'expires-bad') body.expires_in = 'soon';
    if (behavior === 'no-expiry') delete body.expires_in;
    if (behavior === 'no-access-token') delete body.access_token;
    if (behavior === 'long-access-token') body.access_token = 'a'.repeat(8_001);
    if (behavior === 'long-refresh-token')
      body.refresh_token = 'r'.repeat(16_385);
    if (behavior === 'at-limit') {
      body.access_token = 'a'.repeat(8_000);
      tokens.set(body.access_token, { clientId, revoked: false });
      body.refresh_token = 'r'.repeat(16_384);
      clientState(clientId).currentRefresh = body.refresh_token;
    }
    const withoutRefresh = ['no-refresh', 'no-expiry'].includes(behavior);
    if (
      grantType === 'authorization_code' &&
      !withoutRefresh &&
      body.refresh_token === undefined
    )
      body.refresh_token = issueRefresh(clientId);
    if (
      grantType === 'refresh_token' &&
      ['rotating-reuse', 'rotating', 'delayed'].includes(behavior)
    )
      body.refresh_token = issueRefresh(clientId);
    return body;
  };

  const failureAnswer = (behavior, response, retryAfterSeconds) => {
    if (behavior === '503') {
      json(response, 503, { message: 'unavailable' });
      return true;
    }
    if (behavior === '429') {
      json(
        response,
        429,
        { message: 'slow down' },
        { 'retry-after': String(retryAfterSeconds) },
      );
      return true;
    }
    if (behavior === 'teapot') {
      json(response, 418, { message: 'a 4xx with no oauth error' });
      return true;
    }
    if (behavior === 'error-200') {
      json(response, 200, {
        error: 'invalid_grant',
        error_description: OAUTH2_STAND_IN_DESCRIPTION,
      });
      return true;
    }
    if (behavior === 'redirect' || behavior === 'redirect-307') {
      // A 307 keeps the method and body, so only it would carry a secret along.
      response.writeHead(behavior === 'redirect' ? 302 : 307, {
        location: `${origin}/redirect-target`,
      });
      response.end();
      return true;
    }
    if (behavior === 'oversized') {
      json(response, 200, {
        access_token: secretToken('stand-in-at'),
        token_type: 'Bearer',
        padding: 'x'.repeat(OAUTH2_STAND_IN_RESPONSE_LIMIT_BYTES + 1),
      });
      return true;
    }
    if (behavior === 'not-json') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>access_token=not-really-json</html>');
      return true;
    }
    const oauthError = OAUTH_ERRORS[behavior];
    if (oauthError !== undefined) {
      const status = ['server_error', 'temporarily_unavailable'].includes(
        oauthError,
      )
        ? 503
        : oauthError === 'invalid_client'
          ? 401
          : 400;
      json(response, status, {
        error: oauthError,
        error_description: OAUTH2_STAND_IN_DESCRIPTION,
      });
      return true;
    }
    return false;
  };

  const answerToken = (record, clientId, form, response) => {
    const state = clientState(clientId);
    state.tokenAnswers += 1;
    // A scripted answer settles this one request, whatever the client does next.
    const scripted = state.answers.shift();
    const behavior = scripted ?? state.behavior;
    if (failureAnswer(behavior, response, state.retryAfterSeconds)) return;
    const grantType = form.get('grant_type');
    if (grantType === 'refresh_token') {
      const presented = form.get('refresh_token');
      const reused = state.usedRefresh.has(presented);
      const stale = reused || presented !== state.currentRefresh;
      if (state.revoked || (stale && !state.acceptsAnyRefresh)) {
        if (reused && state.behavior === 'rotating-reuse')
          revokeFamily(clientId);
        json(response, 400, {
          error: 'invalid_grant',
          error_description: OAUTH2_STAND_IN_DESCRIPTION,
        });
        return;
      }
      if (['rotating-reuse', 'rotating', 'delayed'].includes(behavior))
        state.usedRefresh.add(presented);
    }
    if (grantType === 'authorization_code') {
      const code = form.get('code');
      const issued = codes.get(code);
      const verifier = form.get('code_verifier');
      const challengeMatches =
        issued?.codeChallenge === undefined
          ? verifier === null
          : createHash('sha256')
              .update(verifier ?? '')
              .digest('base64url') === issued.codeChallenge;
      if (
        issued === undefined ||
        issued.clientId !== clientId ||
        issued.redirectUri !== form.get('redirect_uri') ||
        !challengeMatches
      ) {
        json(response, 400, { error: 'invalid_grant' });
        return;
      }
      codes.delete(code);
      // A new consent gives a new family; only then is an old revocation over.
      state.revoked = false;
      state.usedRefresh.clear();
    }
    const body = tokenBody(clientId, grantType);
    // What this request was given, so a test can follow a token to where it is used.
    record.issued = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
    };
    json(response, 200, body);
  };

  const handleToken = async (record, response) => {
    const form = new URLSearchParams(record.body);
    const authentication =
      clientFromBasicHeader(record.headers.authorization) ??
      (form.has('client_id')
        ? {
            method: 'body',
            clientId: form.get('client_id'),
            clientSecret: form.get('client_secret') ?? '',
          }
        : undefined);
    record.authentication = authentication;
    record.form = Object.fromEntries(form);
    if (authentication === undefined) {
      json(response, 401, { error: 'invalid_client' });
      return;
    }
    const { clientId, clientSecret } = authentication;
    record.clientId = clientId;
    const state = clientState(clientId);
    if (state.secret !== undefined && state.secret !== clientSecret) {
      json(response, 401, { error: 'invalid_client' });
      return;
    }
    const hold = state.holds.shift();
    if (hold !== undefined) {
      hold.arrived();
      await hold.released;
    } else if (state.behavior === 'delayed')
      await new Promise((resolve) => {
        setTimeout(resolve, DELAYED_MS);
      });
    answerToken(record, clientId, form, response);
  };

  const handleApi = (record, response, url) => {
    const bearer = /^Bearer (.+)$/u.exec(record.headers.authorization ?? '');
    const token = bearer === null ? undefined : tokens.get(bearer[1]);
    if (token === undefined || token.revoked) {
      json(response, 401, { error: 'invalid_token' });
      return;
    }
    record.clientId = token.clientId;
    const state = clientState(token.clientId);
    state.apiCalls += 1;
    if (state.behavior === 'api-401') {
      json(response, 401, { error: 'invalid_token' });
      return;
    }
    if (state.behavior === 'api-403') {
      json(response, 403, { error: 'insufficient_scope' });
      return;
    }
    if (state.behavior === 'api-401-once' && !state.api401Sent) {
      state.api401Sent = true;
      json(response, 401, { error: 'invalid_token' });
      return;
    }
    if (url.pathname.endsWith('/pages')) {
      const page = Number(url.searchParams.get('page') ?? '1');
      if (
        state.behavior === 'api-401-page-3' &&
        page === 3 &&
        !state.api401Sent
      ) {
        state.api401Sent = true;
        json(response, 401, { error: 'invalid_token' });
        return;
      }
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      json(response, 200, {
        items: [{ id: page }],
        next:
          page < OAUTH2_STAND_IN_PAGES
            ? `${origin}${next.pathname}${next.search}`
            : null,
      });
      return;
    }
    if (record.method === 'HEAD') {
      response.writeHead(200);
      response.end();
      return;
    }
    json(response, 200, { ok: true, method: record.method });
  };

  const handleAuthorize = (record, response, url) => {
    const clientId = url.searchParams.get('client_id');
    if (clientId === null) {
      response.writeHead(400);
      response.end('client_id is required');
      return;
    }
    record.clientId = clientId;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(authorizePage(Object.fromEntries(url.searchParams)));
  };

  const handleDecision = (record, response) => {
    const form = new URLSearchParams(record.body);
    const clientId = form.get('client_id') ?? '';
    record.clientId = clientId;
    const target = new URL(form.get('redirect_uri') ?? '');
    const state = form.get('state');
    if (state !== null) target.searchParams.set('state', state);
    const decision = form.get('decision');
    if (decision === 'approve') {
      const code = secretToken('stand-in-code');
      codes.set(code, {
        clientId,
        redirectUri: form.get('redirect_uri'),
        codeChallenge: form.get('code_challenge') ?? undefined,
      });
      target.searchParams.set('code', code);
    } else {
      // An `error:<code>` decision is any provider error that isn't a refusal.
      target.searchParams.set(
        'error',
        decision?.startsWith('error:') === true
          ? decision.slice(6)
          : 'access_denied',
      );
      target.searchParams.set('error_description', OAUTH2_STAND_IN_DESCRIPTION);
    }
    response.writeHead(302, { location: target.toString() });
    response.end();
  };

  const handleControl = (record, response, url) => {
    const form = record.body === '' ? {} : JSON.parse(record.body);
    if (url.pathname === '/control/revoke') {
      revokeFamily(form.clientId);
      json(response, 200, { revoked: true });
      return;
    }
    if (url.pathname === '/control/requests') {
      const clientId = url.searchParams.get('clientId');
      json(response, 200, {
        token: requests.filter(
          (seen) => seen.path === '/token' && seen.clientId === clientId,
        ).length,
        api: requests.filter(
          (seen) => seen.path.startsWith('/api') && seen.clientId === clientId,
        ).length,
      });
      return;
    }
    response.writeHead(404);
    response.end();
  };

  const server = createServer((request, response) => {
    openResponses.add(response);
    response.on('close', () => openResponses.delete(response));
    void (async () => {
      const body = await readBody(request);
      const url = new URL(request.url ?? '/', origin);
      const record = {
        at: Date.now(),
        method: request.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        host: request.headers.host,
        body,
      };
      if (!url.pathname.startsWith('/control/')) requests.push(record);
      if (url.pathname === '/token' && record.method === 'POST')
        await handleToken(record, response);
      else if (url.pathname === '/authorize') {
        handleAuthorize(record, response, url);
      } else if (url.pathname === '/authorize/decide') {
        handleDecision(record, response);
      } else if (url.pathname.startsWith('/api')) {
        handleApi(record, response, url);
      } else if (url.pathname.startsWith('/control/')) {
        handleControl(record, response, url);
      } else {
        json(response, 200, { received: true });
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });
  const address = server.address();
  origin = `http://${host}:${String(address.port)}`;

  return Object.freeze({
    origin,
    /** Every request received, oldest first. */
    requests,
    tokenRequests: (clientId) =>
      requests.filter(
        (seen) => seen.path === '/token' && seen.clientId === clientId,
      ),
    apiCalls: (clientId) =>
      requests.filter(
        (seen) => seen.path.startsWith('/api') && seen.clientId === clientId,
      ),
    redirectTargetRequests: () =>
      requests.filter((seen) => seen.path === '/redirect-target'),
    authorizeRequests: (clientId) =>
      requests.filter(
        (seen) => seen.path === '/authorize' && seen.clientId === clientId,
      ),
    /** The token address then refuses any other secret with `invalid_client`. */
    expectSecret(clientId, secret) {
      clientState(clientId).secret = secret;
    },
    setBehavior(clientId, behavior) {
      clientState(clientId).behavior = behavior;
    },
    setExpiresIn(clientId, seconds) {
      clientState(clientId).expiresIn = seconds;
    },
    setRetryAfter(clientId, seconds) {
      clientState(clientId).retryAfterSeconds = seconds;
    },
    /** Answers even a refresh token it has replaced: a slow service mid-rotation. */
    acceptAnyRefresh(clientId) {
      clientState(clientId).acceptsAnyRefresh = true;
    },
    /** The next token requests answer this way, one each, before the behavior. */
    scriptAnswers(clientId, behaviors) {
      clientState(clientId).answers.push(...behaviors);
    },
    /**
     * Holds this client's next token request until released, so a test decides
     * the order things happen in. It resolves `arrived` once the request is here.
     */
    holdNextToken(clientId) {
      const hold = {};
      hold.arrivedPromise = new Promise((resolve) => {
        hold.arrived = resolve;
      });
      hold.released = new Promise((resolve) => {
        hold.release = resolve;
      });
      clientState(clientId).holds.push(hold);
      held.add(hold);
      return Object.freeze({
        arrived: hold.arrivedPromise,
        release: () => {
          hold.release();
          held.delete(hold);
        },
      });
    },
    /** The service revokes the grant: its tokens and refresh token stop working. */
    revoke(clientId) {
      revokeFamily(clientId);
    },
    /** A new client of this behavior, isolated from every other test. */
    newClient(behavior) {
      return `${behavior}.${randomBytes(6).toString('hex')}`;
    },
    /** Goes down for real: connections are cut and the port stops listening. */
    async close() {
      for (const hold of held) hold.release();
      for (const response of openResponses) response.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
  });
}
