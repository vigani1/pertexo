import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { OAUTH2_STAND_IN_DESCRIPTION } from '../../../../../infrastructure/testing/oauth2-stand-in.mjs';
import {
  CALLBACK_PATH,
  describeOAuth2,
  REDIRECT_URI,
  startOAuth2Harness,
  useOAuth2Timeouts,
  type Connection,
  type OAuth2Harness,
  type Owner,
} from '../../support/oauth2/harness.js';

useOAuth2Timeouts();

const FORBIDDEN_PROBLEM = 403;

describeOAuth2('starting OAuth2 consent', () => {
  let harness: OAuth2Harness;

  beforeAll(async () => {
    harness = await startOAuth2Harness('consent-start');
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

  const stateOf = (url: string): string =>
    new URL(url).searchParams.get('state') ?? '';

  // Roles table: a Viewer can't start.
  it.fails('a viewer can’t start consent', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const viewer = await harness.addMember(owner.workspaceId, 'viewer');
    const started = await harness.start(viewer.api, owner, connection.id);
    expect(started.status).toBe(FORBIDDEN_PROBLEM);
    expect(await harness.pendingRows(connection.id)).toBe(0);
  });

  // Roles table: Operator and Builder ("Editor" roles) only have connection:use.
  it.fails.each(['operator', 'builder'] as const)(
    'a %s can’t start consent',
    async (role) => {
      const owner = await harness.newOwner();
      const connection = await harness.create(owner, 'non-rotating');
      const member = await harness.addMember(owner.workspaceId, role);
      const started = await harness.start(member.api, owner, connection.id);
      expect(started.status).toBe(FORBIDDEN_PROBLEM);
      expect(await harness.pendingRows(connection.id)).toBe(0);
    },
  );

  // Roles table: Owner and Admin have connection:manage.
  it.fails('an admin and an owner can start consent', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const admin = await harness.addMember(owner.workspaceId, 'admin');
    expect((await harness.start(admin.api, owner, connection.id)).status).toBe(
      200,
    );
    expect((await harness.start(owner.api, owner, connection.id)).status).toBe(
      200,
    );
  });

  // S28: another workspace's id gets 404 on the start route.
  it.fails('another workspace gets 404, and its member nothing', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const outsider = await harness.newOwner();
    expect(
      (await harness.start(outsider.api, owner, connection.id)).status,
    ).toBe(404);
    const throughOwn = await harness.start(
      outsider.api,
      outsider,
      connection.id,
    );
    expect(throughOwn.status).toBe(404);
    expect(await harness.pendingRows(connection.id)).toBe(0);
    expect(harness.standIn.tokenRequests(connection.clientId)).toEqual([]);
  });

  // Proof list: start needs CSRF.
  it.fails('start needs the CSRF token', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const started = await owner.api.call(
      'POST',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/oauth2/authorization`,
      undefined,
      { 'x-csrf-token': 'not-the-token' },
    );
    expect(started.status).toBe(FORBIDDEN_PROBLEM);
    expect(await harness.pendingRows(connection.id)).toBe(0);
  });

  // S1: the state is <workspace, 22 chars>.<43 chars>; only its digest is stored.
  it.fails('S1 stores only the digest of the state it gives out', async () => {
    const { connection, callbackUrl } = await pendingConsent();
    const state = stateOf(callbackUrl);
    expect(state).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u);
    const [row] = await harness.stack.sql<{
      state_digest: Buffer;
      binding_digest: Buffer;
    }>(
      `select state_digest, binding_digest from app.connection_oauth2_authorizations
        where connection_id=$1`,
      [connection.id],
    );
    expect(row?.state_digest.toString('hex')).toBe(
      createHash('sha256').update(state).digest('hex'),
    );
  });

  // S5: the binding cookie's name and every attribute.
  it.fails('S5 sets the binding cookie exactly as written', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const started = await harness.start(owner.api, owner, connection.id);
    const name = `pertexo_oauth2_${connection.id.replaceAll('-', '')}`;
    const line = started.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${name}=`));
    expect(line).toBeDefined();
    const parts = (line ?? '').split(';').map((part) => part.trim());
    const value = parts[0]?.slice(name.length + 1) ?? '';
    // 256 random bits, base64url: at least 43 characters.
    expect(value).toMatch(/^[A-Za-z0-9_-]{43,}$/u);
    // Attribute names aren't case-sensitive, and the path here is all lowercase.
    const attributes = parts.slice(1).map((part) => part.toLowerCase());
    expect(attributes).toContain('httponly');
    expect(attributes).toContain('samesite=lax');
    expect(attributes).toContain(`path=${CALLBACK_PATH}`);
    expect(attributes).toContain('max-age=600');
    // The web origin here is plain http, so no Secure: "Secure on HTTPS".
    expect(attributes).not.toContain('secure');
    const [row] = await harness.stack.sql<{ binding_digest: Buffer }>(
      `select binding_digest from app.connection_oauth2_authorizations
        where connection_id=$1`,
      [connection.id],
    );
    // "The row keeps its digest", never the value.
    expect(row?.binding_digest).toHaveLength(32);
    expect(row?.binding_digest.toString('utf8')).not.toBe(value);
    expect(row?.binding_digest.toString('base64url')).not.toBe(value);
  });

  // S12: the redirect URI is the install's, in the start URL, the exchange and the response.
  it.fails(
    'S12 sends the install’s redirect URI, whatever the request says',
    async () => {
      const owner = await harness.newOwner();
      const connection = await harness.create(owner, 'non-rotating');
      expect(connection.body).toMatchObject({
        oauth2: { redirectUri: REDIRECT_URI },
      });
      const started = await owner.api.call(
        'POST',
        `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/oauth2/authorization`,
        undefined,
        {
          'x-forwarded-host': 'evil.example.test',
          'x-forwarded-proto': 'https',
        },
      );
      const url = new URL(harness.authorizationUrl(started));
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      const landing = await harness.land(
        owner.api,
        await harness.decide(url.toString(), 'approve'),
      );
      expect(landing.result).toBe('connected');
      const [exchange] = harness.standIn.tokenRequests(connection.clientId);
      expect(exchange?.form?.redirect_uri).toBe(REDIRECT_URI);
    },
  );

  // Decisions, PKCE: on by default with S256; the stand-in checks verifier against challenge.
  it.fails('PKCE: the verifier matches the challenge', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const url = new URL(
      harness.authorizationUrl(
        await harness.start(owner.api, owner, connection.id),
      ),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = url.searchParams.get('code_challenge') ?? '';
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const landing = await harness.land(
      owner.api,
      await harness.decide(url.toString(), 'approve'),
    );
    expect(landing.result).toBe('connected');
    const [exchange] = harness.standIn.tokenRequests(connection.clientId);
    const verifier = exchange?.form?.code_verifier ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      challenge,
    );
    // RFC 7636 §4.1: at least 43 characters.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  // S21: derived from the state, so two consents have different verifiers.
  it.fails('S21 derives a different verifier for each consent', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    for (const _ of [1, 2]) {
      const url = harness.authorizationUrl(
        await harness.start(owner.api, owner, connection.id),
      );
      await harness.land(owner.api, await harness.decide(url, 'approve'));
    }
    const verifiers = harness.standIn
      .tokenRequests(connection.clientId)
      .map(({ form }) => form?.code_verifier);
    expect(verifiers).toHaveLength(2);
    expect(verifiers[0]).not.toBe(verifiers[1]);
  });

  // Decisions, PKCE: the Advanced switch sends neither challenge nor verifier.
  it.fails('PKCE off sends neither', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating', {
      pkce: 'none',
    });
    const url = new URL(
      harness.authorizationUrl(
        await harness.start(owner.api, owner, connection.id),
      ),
    );
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.searchParams.has('code_challenge_method')).toBe(false);
    const landing = await harness.land(
      owner.api,
      await harness.decide(url.toString(), 'approve'),
    );
    expect(landing.result).toBe('connected');
    const [exchange] = harness.standIn.tokenRequests(connection.clientId);
    expect(exchange?.form?.code_verifier).toBeUndefined();
  });

  // S3: 600 s, stored by database time and answered in the start response.
  it.fails('S3 keeps a consent open for 600 seconds', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const started = await harness.start(owner.api, owner, connection.id);
    const [row] = await harness.stack.sql<{ seconds: number }>(
      `select extract(epoch from expires_at - clock_timestamp())::int as seconds
         from app.connection_oauth2_authorizations where connection_id=$1`,
      [connection.id],
    );
    expect(row?.seconds).toBeGreaterThan(590);
    expect(row?.seconds).toBeLessThanOrEqual(600);
    expect(typeof (started.json as { expiresAt: unknown }).expiresAt).toBe(
      'string',
    );
  });

  // Plan, Contract: server-to-server is connected at once, with no consent.
  it.fails('client credentials connects at once', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.createServer(owner, 'non-rotating');
    const started = await harness.start(owner.api, owner, connection.id);
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({
      kind: 'connected',
      connection: {
        id: connection.id,
        status: 'active',
        grant: {
          renewable: true,
          accessTokenExpiresAt: expect.any(String) as string,
        },
      },
    });
    expect(started.headers.getSetCookie().join(';')).not.toContain(
      'pertexo_oauth2_',
    );
    const [request] = harness.standIn.tokenRequests(connection.clientId);
    expect(request?.form?.grant_type).toBe('client_credentials');
    expect(await harness.pendingRows(connection.id)).toBe(0);
  });

  // Plan, Contract: a client-credentials start that the service refused is a 409.
  it.fails.each(['invalid-client', 'unauthorized-client', 'invalid-scope'])(
    'a client-credentials start answered %s is connection.oauth2_token_refused',
    async (behavior) => {
      const owner = await harness.newOwner();
      const connection = await harness.createServer(owner, behavior);
      const started = await harness.start(owner.api, owner, connection.id);
      expect(started.status).toBe(409);
      expect(started.json).toMatchObject({
        code: 'connection.oauth2_token_refused',
      });
      expect(JSON.stringify(started.json)).not.toContain(
        OAUTH2_STAND_IN_DESCRIPTION,
      );
      expect(await harness.tokenRow(connection.id)).toBeUndefined();
    },
  );

  // Plan, Contract: an outage on start is the existing provider.unavailable.
  it.fails(
    'a client-credentials start during an outage is provider.unavailable',
    async () => {
      const owner = await harness.newOwner();
      const connection = await harness.createServer(owner, '503');
      const started = await harness.start(owner.api, owner, connection.id);
      expect(started.status).toBe(503);
      expect(started.json).toMatchObject({ code: 'provider.unavailable' });
    },
  );

  // Plan, Contract: starting on a revoked connection is connection.revoked.
  it.fails('start on a revoked connection is connection.revoked', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    await owner.api.call(
      'DELETE',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}`,
    );
    const started = await harness.start(owner.api, owner, connection.id);
    expect(started.json).toMatchObject({ code: 'connection.revoked' });
  });

  // Plan, Contract: start on a non-OAuth2 connection is connection.conflict.
  it.fails('start on a header connection is connection.conflict', async () => {
    const owner = await harness.newOwner();
    const created = await owner.api.call(
      'POST',
      `/v1/workspaces/${owner.workspaceId}/connections`,
      {
        providerKey: 'http',
        name: 'Plain headers',
        credential: {
          type: 'http_headers',
          headers: { authorization: 'Bearer value' },
        },
      },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(created.status).toBe(201);
    const started = await harness.start(
      owner.api,
      owner,
      (created.json as { id: string }).id,
    );
    expect(started.status).toBe(409);
    expect(started.json).toMatchObject({ code: 'connection.conflict' });
  });

  // S15: start also decides addresses, so a stored address that's no longer allowed is refused.
  it.fails(
    'S15 start refuses a stored address that is now refused',
    async () => {
      const owner = await harness.newOwner();
      const connection = await harness.createServer(owner, 'non-rotating');
      await harness.setTokenUrl(connection.id, 'http://10.0.0.5/token');
      const started = await harness.start(owner.api, owner, connection.id);
      expect(started.status).toBe(400);
      expect(started.json).toMatchObject({
        code: 'connection.oauth2_endpoint_refused',
      });
      expect(harness.standIn.tokenRequests(connection.clientId)).toEqual([]);
    },
  );
});
