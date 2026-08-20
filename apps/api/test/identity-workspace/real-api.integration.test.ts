import { createHash, randomUUID } from 'node:crypto';

import {
  auditEvents,
  createIdentityWorkspaceDatabase,
  createOidcLoginTransactionStore,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  workspaceMemberships,
  workspaces,
  type WorkspaceDatabase,
} from '@pertexo/database';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiApplication } from '../../src/app.js';
import { createOidcSecretEncryptionAdapter } from '../../src/identity-infrastructure/index.js';
import type {
  OidcAuthorizationRequest,
  OidcProviderPort,
} from '../../src/identity/index.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';

const apiUrl = process.env.DATABASE_API_URL;
const enabled =
  process.env.API_IDENTITY_INTEGRATION === 'true' && apiUrl !== undefined;
const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';
const issuer = 'https://identity.integration.test';
const clientId = 'phase1-real-api';
const encryptionKey = Buffer.alloc(32, 0x5a).toString('base64');
const databaseConfig = parseDatabaseConfig({
  connectionString: apiUrl ?? 'postgresql://invalid:invalid@localhost/invalid',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 4,
  ownerRole,
});

const logger: StructuredLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
};
const telemetry: TelemetryLifecycle = {
  enabled: false,
  started: false,
  start: () => undefined,
  shutdown: () => Promise.resolve(),
};

class FakeOidcProvider implements OidcProviderPort {
  public latestRequest: OidcAuthorizationRequest | undefined;
  public latestVerifier: string | undefined;
  public exchangeCount = 0;

  public authorizationUrl(request: OidcAuthorizationRequest): string {
    this.latestRequest = request;
    const url = new URL(`${issuer}/authorize`);
    url.searchParams.set('client_id', request.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('scope', request.scopes.join(' '));
    url.searchParams.set('state', request.state);
    url.searchParams.set('nonce', request.nonce);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
    return url.toString();
  }

  public exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) {
    this.exchangeCount += 1;
    this.latestVerifier = input.codeVerifier;
    if (input.code === 'provider-failure') {
      throw new Error('provider-secret-must-never-leak');
    }
    const request = this.latestRequest;
    if (request === undefined) throw new Error('authorization was not started');
    return Promise.resolve({
      issuer,
      subject: 'phase1-real-stack-user',
      audience: clientId,
      nonce:
        input.code === 'bad-nonce'
          ? 'forged-nonce-that-does-not-match'
          : request.nonce,
      email: 'phase1-real-stack@example.test',
      displayName: 'Phase One Real Stack',
      emailVerified: true,
    });
  }
}

type SessionCookies = Readonly<{
  rawSession: string;
  csrf: string;
  cookieHeader: string;
}>;

describe.runIf(enabled)('Phase 1 real PostgreSQL API identity slice', () => {
  const provider = new FakeOidcProvider();
  const identityDatabase = createIdentityWorkspaceDatabase(databaseConfig);
  const transactionStore = createOidcLoginTransactionStore(
    databaseConfig,
    createOidcSecretEncryptionAdapter({
      current: { version: 'integration-v1', key: encryptionKey },
    }),
  );
  let application: Awaited<ReturnType<typeof createApiApplication>>;
  let workspaceDatabase: WorkspaceDatabase;
  let primaryWorkspaceId: string;

  beforeAll(async () => {
    workspaceDatabase = createWorkspaceDatabase(databaseConfig);
    application = await createApiApplication(config(), {
      database: workspaceDatabase,
      identityOverrides: {
        provider,
        database: identityDatabase,
        transactions: transactionStore,
      },
      logger,
      telemetry,
    });
    await application.init();
  });

  afterAll(async () => {
    await application.close();
  });

  it('persists state, nonce, and PKCE and establishes only secure opaque cookies', async () => {
    const start = await startLogin();
    const request = requireAuthorizationRequest();
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.get('state')).toBe(request.state);
    expect(authorizationUrl.searchParams.get('nonce')).toBe(request.nonce);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );

    const callback = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=valid&state=${encodeURIComponent(request.state)}`,
    });
    expect(callback.statusCode).toBe(204);
    const cookies = sessionCookies(callback.headers['set-cookie']);
    expect(String(callback.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(callback.headers['set-cookie'])).toContain('Secure');
    expect(String(callback.headers['set-cookie'])).toContain('SameSite=Lax');
    expect(cookies.rawSession).not.toBe(cookies.csrf);
    expect(provider.latestVerifier).toBeDefined();
    expect(sha256Base64Url(provider.latestVerifier ?? '')).toBe(
      request.codeChallenge,
    );

    const digest = sha256Hex(cookies.rawSession);
    const stored = await identityDatabase.findActiveSessionByDigest(digest);
    expect(stored).not.toBeNull();
    expect(stored?.tokenDigest).toBe(digest);
    expect(JSON.stringify(stored)).not.toContain(cookies.rawSession);

    const exchangeCount = provider.exchangeCount;
    const replay = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=valid&state=${encodeURIComponent(request.state)}`,
    });
    expectProblem(replay, 400, 'request.invalid');
    expect(provider.exchangeCount).toBe(exchangeCount);

    const tampered = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=valid&state=${'x'.repeat(43)}`,
    });
    expectProblem(tampered, 400, 'request.invalid');
    expect(provider.exchangeCount).toBe(exchangeCount);
  });

  it('rejects nonce mismatch and sanitizes provider failures as RFC 9457 problems', async () => {
    const nonceStart = await startLogin();
    const nonceState = new URL(nonceStart.authorizationUrl).searchParams.get(
      'state',
    );
    expect(nonceState).not.toBeNull();
    const nonceFailure = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=bad-nonce&state=${encodeURIComponent(nonceState ?? '')}`,
    });
    expectProblem(nonceFailure, 400, 'request.invalid');
    expect(nonceFailure.payload).not.toContain('forged-nonce');

    const providerStart = await startLogin();
    const providerState = new URL(
      providerStart.authorizationUrl,
    ).searchParams.get('state');
    const providerFailure = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=provider-failure&state=${encodeURIComponent(providerState ?? '')}`,
    });
    expectProblem(providerFailure, 503, 'provider.unavailable');
    expect(providerFailure.payload).not.toContain(
      'provider-secret-must-never-leak',
    );
  });

  it('enforces CSRF and atomically creates an owner membership and correlated audit fact', async () => {
    const cookies = await login();
    const slug = `phase1-${randomUUID().slice(0, 12)}`;
    const missingCsrf = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie: cookies.cookieHeader },
      payload: { name: 'Rejected Workspace', slug: `${slug}-rejected` },
    });
    expectProblem(missingCsrf, 403, 'auth.forbidden');

    const requestId = `phase1-create-${randomUUID()}`;
    const traceId = randomUUID().replaceAll('-', '');
    const created = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies, {
        'x-request-id': requestId,
        traceparent: `00-${traceId}-0123456789abcdef-01`,
      }),
      payload: { name: 'Phase One Workspace', slug },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['x-request-id']).toBe(requestId);
    const workspace = created.json<{ id: string; status: string }>();
    expect(workspace.status).toBe('active');
    primaryWorkspaceId = workspace.id;

    const aggregate = await workspaceAggregate(workspace.id);
    expect(aggregate.memberships).toHaveLength(1);
    expect(aggregate.memberships[0]).toMatchObject({ role: 'owner' });
    expect(aggregate.events).toHaveLength(1);
    expect(aggregate.events[0]).toMatchObject({
      action: 'workspace.created',
      requestId,
      traceId,
    });

    const duplicate = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: { name: 'Duplicate Workspace', slug },
    });
    expectProblem(duplicate, 409, 'workspace.conflict');
    const unchanged = await workspaceAggregate(workspace.id);
    expect(unchanged.memberships).toHaveLength(1);
    expect(unchanged.events).toHaveLength(1);

    const forgedRole = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: { name: 'Forged Role', slug: `${slug}-forged`, role: 'owner' },
    });
    expectProblem(forgedRole, 400, 'request.invalid');

    const forgedWorkspace = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${randomUUID()}/deletion`,
      headers: mutationHeaders(cookies),
      payload: { reason: 'forged workspace context' },
    });
    expectProblem(forgedWorkspace, 403, 'auth.forbidden');
  });

  it('records deletion reason, revokes sessions, restores once, and reports lifecycle conflicts', async () => {
    const deletionCookies = await login();
    const deletionRequestId = `phase1-delete-${randomUUID()}`;
    const deletion = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(deletionCookies, {
        'x-request-id': deletionRequestId,
      }),
      payload: { reason: 'customer requested integration deletion' },
    });
    expect(deletion.statusCode).toBe(201);
    expect(deletion.json()).toMatchObject({ status: 'pending_deletion' });

    const revoked = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(deletionCookies),
      payload: {
        name: 'Must Not Be Created',
        slug: `revoked-${randomUUID().slice(0, 12)}`,
      },
    });
    expectProblem(revoked, 401, 'auth.unauthenticated');

    const pending = await workspaceAggregate(primaryWorkspaceId);
    expect(pending.workspace).toMatchObject({
      status: 'pending_deletion',
      deletionReason: 'customer requested integration deletion',
    });
    expect(pending.events.at(-1)).toMatchObject({
      action: 'workspace.deletion_requested',
      requestId: deletionRequestId,
    });

    const restoreCookies = await login();
    const restore = await application.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(restoreCookies),
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json()).toMatchObject({ status: 'suspended' });

    const repeatedRestore = await application.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(restoreCookies),
    });
    expectProblem(repeatedRestore, 409, 'workspace.conflict');
    const restored = await workspaceAggregate(primaryWorkspaceId);
    expect(restored.workspace).toMatchObject({
      status: 'suspended',
      deletionReason: null,
    });
  });

  it('rejects explicitly revoked and expired sessions without exposing cookie values', async () => {
    const logoutCookies = await login();
    const logout = await application.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: mutationHeaders(logoutCookies),
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    const afterLogout = await authenticatedMutation(logoutCookies);
    expectProblem(afterLogout, 401, 'auth.unauthenticated');
    expect(afterLogout.payload).not.toContain(logoutCookies.rawSession);

    const expiringCookies = await login();
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const expired = await authenticatedMutation(expiringCookies);
    expectProblem(expired, 401, 'auth.unauthenticated');
    expect(expired.payload).not.toContain(expiringCookies.rawSession);
  });

  async function startLogin(): Promise<{
    authorizationUrl: string;
    expiresAt: string;
  }> {
    const response = await application.inject({
      method: 'GET',
      url: '/v1/auth/oidc/start',
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function login(): Promise<SessionCookies> {
    const start = await startLogin();
    const state = new URL(start.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('OIDC state was not returned');
    const response = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=valid&state=${encodeURIComponent(state)}`,
    });
    expect(response.statusCode).toBe(204);
    return sessionCookies(response.headers['set-cookie']);
  }

  async function authenticatedMutation(cookies: SessionCookies) {
    return application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: {
        name: 'Session Probe',
        slug: `session-probe-${randomUUID().slice(0, 12)}`,
      },
    });
  }

  async function workspaceAggregate(workspaceId: string) {
    return workspaceDatabase.withWorkspace(workspaceId, async ({ db }) => {
      const workspaceRows = await db.select().from(workspaces);
      return {
        events: await db.select().from(auditEvents),
        memberships: await db.select().from(workspaceMemberships),
        workspace: workspaceRows.find((row) => row.id === workspaceId),
      };
    });
  }

  function requireAuthorizationRequest(): OidcAuthorizationRequest {
    const request = provider.latestRequest;
    if (request === undefined) throw new Error('OIDC request was not captured');
    return request;
  }
});

function config(): ApiConfig {
  return {
    database: databaseConfig,
    host: '127.0.0.1',
    identity: {
      oidc: {
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
        jwksUri: `${issuer}/jwks`,
        clientId,
        redirectUri: 'https://api.integration.test/v1/auth/oidc/callback',
        scopes: ['openid', 'profile', 'email'],
        allowedAlgorithms: ['RS256'],
        timeoutMillis: 5_000,
        transactionTtlMillis: 30_000,
        allowInsecureHttpForTests: false,
      },
      secretEncryption: {
        current: { version: 'integration-v1', key: encryptionKey },
        previous: [],
      },
      session: {
        ttlMillis: 5_000,
        secureCookie: true,
        sameSite: 'lax',
      },
    },
    nodeEnv: 'test',
    observability: {
      environment: 'test',
      logLevel: 'silent',
      otlpHeaders: {},
      serviceName: 'pertexo-api',
      serviceVersion: 'phase1-integration',
    },
    port: 3000,
  };
}

function sessionCookies(header: string | string[] | undefined): SessionCookies {
  const values = Array.isArray(header) ? header : [header ?? ''];
  const flattened = values.flatMap((value) => value.split(/,(?=[^;]+?=)/u));
  const session = cookieValue(flattened, 'pertexo_session');
  const csrf = cookieValue(flattened, 'pertexo_csrf');
  return {
    rawSession: session,
    csrf,
    cookieHeader: `pertexo_session=${session}; pertexo_csrf=${csrf}`,
  };
}

function cookieValue(values: readonly string[], name: string): string {
  const prefix = `${name}=`;
  for (const value of values) {
    const pair = value.split(';', 1)[0]?.trim();
    if (pair?.startsWith(prefix))
      return decodeURIComponent(pair.slice(prefix.length));
  }
  throw new Error(`${name} cookie was not returned`);
}

function mutationHeaders(
  cookies: SessionCookies,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    cookie: cookies.cookieHeader,
    'x-csrf-token': cookies.csrf,
    ...extra,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function expectProblem(
  response: Readonly<{
    statusCode: number;
    payload: string;
    headers: Readonly<Record<string, unknown>>;
    json(): unknown;
  }>,
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(String(response.headers['content-type'])).toContain(
    'application/problem+json',
  );
  const problem = response.json() as Readonly<Record<string, unknown>>;
  expect(problem).toMatchObject({
    type: `urn:pertexo:problem:${code}`,
    status,
    code,
  });
  expect(problem.title).toEqual(expect.stringMatching(/^\S/u));
  expect(problem.requestId).toEqual(expect.stringMatching(/^\S/u));
}
