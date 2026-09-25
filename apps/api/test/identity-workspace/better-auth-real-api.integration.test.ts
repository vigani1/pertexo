import { randomUUID } from 'node:crypto';

import {
  createWorkspaceDatabase,
  migrateDatabase,
  parseDatabaseConfig,
  type WorkspaceDatabase,
} from '@pertexo/database/testing';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiApplication } from '../../src/app.js';
import { LocalAuthenticationMailSink } from '../../src/identity-infrastructure/index.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';

/*
 * The whole API with Better Auth as the only session authority and no legacy
 * OIDC: sign-up with a return path, display-name change, invitation
 * acceptance from a fresh sign-in, member removal and rejoining (ADR 042/043).
 */
const enabled = process.env.API_IDENTITY_INTEGRATION === 'true';
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const databaseName = `pertexo_test_ba_api_${randomUUID().replaceAll('-', '')}`;
const origin = 'https://app.integration.test';
const invitationKeys = {
  current: {
    version: 'invite-v1',
    key: Buffer.alloc(32, 0x3c).toString('base64'),
  },
  previous: [],
};
const silent: StructuredLogger = {
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

function databaseUrl(base: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

const databaseConfig = parseDatabaseConfig({
  connectionString: databaseUrl(apiBaseUrl),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 4,
  ownerRole: 'pertexo_owner',
});

type Browser = Readonly<{ session: string; csrf: string; cookie: string }>;
type Reply = Awaited<
  ReturnType<Awaited<ReturnType<typeof createApiApplication>>['inject']>
>;

describe.runIf(enabled)('Better Auth-only real API identity slice', () => {
  const mail = new LocalAuthenticationMailSink();
  let application: Awaited<ReturnType<typeof createApiApplication>>;
  let workspaceDatabase: WorkspaceDatabase | undefined;
  let identityRuntime:
    Awaited<ReturnType<typeof createApiIdentityRuntime>> | undefined;
  let admin: Pool;
  let address = 0;

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker`,
    );
    await admin.end();
    await migrateDatabase({
      apiRuntimeRole: 'pertexo_api',
      connectionString: databaseUrl(migrationBaseUrl),
      dispatcherRole: 'pertexo_dispatcher',
      lifecycleCommandRole: 'pertexo_lifecycle_command',
      maintenanceRole: 'pertexo_maintenance',
      operatorRole: 'pertexo_operator',
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    admin = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const config = apiConfig();
    if (config.identity === undefined) throw new Error('Identity is missing');
    identityRuntime = await createApiIdentityRuntime(
      config.identity,
      databaseConfig,
      { authenticationMail: mail },
    );
    workspaceDatabase = createWorkspaceDatabase(databaseConfig);
    application = await createApiApplication(config, {
      database: workspaceDatabase,
      identityRuntime,
      logger: silent,
      telemetry,
    });
    await application.init();
  }, 60_000);

  afterAll(async () => {
    await application.close();
    await Promise.allSettled([
      identityRuntime?.close(),
      workspaceDatabase?.close(),
      admin.end(),
    ]);
    const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await cleanup.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
        [databaseName],
      );
      await cleanup.query(`drop database if exists "${databaseName}"`);
    } finally {
      await cleanup.end();
    }
  });

  /** Each browser request gets its own client address, like real users. */
  function send(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    input: Readonly<{
      browser?: Browser;
      headers?: Record<string, string>;
      payload?: object;
    }> = {},
  ): Promise<Reply> {
    address += 1;
    return application.inject({
      method,
      url,
      remoteAddress: `203.0.113.${String(address % 250)}`,
      headers: {
        origin,
        ...(input.browser === undefined
          ? {}
          : {
              cookie: input.browser.cookie,
              'x-csrf-token': input.browser.csrf,
            }),
        ...input.headers,
      },
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    });
  }

  async function signUp(email: string, callbackURL: string) {
    const created = await send('POST', '/v1/auth/sign-up/email', {
      payload: {
        name: 'New Person',
        email,
        password: 'a long enough integration password',
        callbackURL,
      },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const link = mail
      .readForTesting(email)
      .find((message) => message.purpose === 'verification');
    if (link === undefined) throw new Error('No verification mail');
    const verified = await send(
      'GET',
      new URL(link.url).pathname + new URL(link.url).search,
    );
    expect(verified.statusCode).toBe(302);
    return {
      link: new URL(link.url),
      landing: new URL(String(verified.headers.location)),
    };
  }

  async function signIn(email: string): Promise<Browser> {
    const signedIn = await send('POST', '/v1/auth/sign-in/email', {
      payload: {
        email,
        password: 'a long enough integration password',
        callbackURL: '/workspaces',
      },
    });
    expect(signedIn.statusCode, signedIn.payload).toBe(200);
    return browserFrom(signedIn);
  }

  async function invitationToken(workspaceId: string, invitationId: string) {
    const rows = await admin.query<{
      id: string;
      token_ciphertext: string;
      token_nonce: string;
      token_tag: string;
      token_key_version: string;
    }>(
      `select id,token_ciphertext,token_nonce,token_tag,token_key_version
         from app.workspace_invitation_delivery_attempts
        where workspace_id=$1 and invitation_id=$2`,
      [workspaceId, invitationId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error('No invitation delivery');
    return createApplicationSecretEnvelope(invitationKeys).open(
      {
        ciphertext: row.token_ciphertext,
        nonce: row.token_nonce,
        tag: row.token_tag,
        keyVersion: row.token_key_version,
      },
      `pertexo/workspace-invitation/${workspaceId}/${invitationId}/${row.id}`,
    );
  }

  /** Invites, resolves the link and verifies the recipient's fresh sign-in. */
  async function openInvitation(
    owner: Browser,
    workspaceId: string,
    email: string,
    recipient: Browser,
  ) {
    const invited = await send(
      'POST',
      `/v1/workspaces/${workspaceId}/invitations`,
      {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { email, role: 'viewer' },
      },
    );
    expect(invited.statusCode, invited.payload).toBe(202);
    const invitationId = invited.json<{ invitation: { id: string } }>()
      .invitation.id;
    const resolved = await send('POST', '/v1/invitation-acceptance/resolve', {
      headers: {
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      payload: { token: await invitationToken(workspaceId, invitationId) },
    });
    expect(resolved.statusCode, resolved.payload).toBe(201);
    const journey = resolved.json<{ state: string; csrfToken: string }>();
    expect(journey.state).toBe('sign_in_required');
    const binding = setCookie(resolved, 'pertexo_invitation_intent');
    const bound: Browser = {
      ...recipient,
      cookie: `${recipient.cookie}; pertexo_invitation_intent=${binding}`,
    };
    return { journey, bound };
  }

  it('carries only an allowlisted return path through email verification', async () => {
    const hostile = await signUp(
      `${randomUUID()}@example.test`,
      '/login?verified=true&returnTo=%2F%2Fevil.example%2Faccount%2Fsecurity',
    );
    expect(hostile.link.searchParams.has('returnTo')).toBe(false);
    expect(hostile.landing.searchParams.has('returnTo')).toBe(false);
    const invited = await signUp(
      `${randomUUID()}@example.test`,
      '/login?verified=true&returnTo=%2Finvitations%2Faccept',
    );
    expect(invited.link.searchParams.get('returnTo')).toBe(
      '/invitations/accept',
    );
    expect(`${invited.landing.origin}${invited.landing.pathname}`).toBe(
      `${origin}/login`,
    );
    expect(invited.landing.searchParams.get('verified')).toBe('true');
    expect(invited.landing.searchParams.get('returnTo')).toBe(
      '/invitations/accept',
    );
  });

  it('renames the signed-in user at the profile revision they saw', async () => {
    const email = `${randomUUID()}@example.test`;
    await signUp(email, '/login?verified=true');
    const browser = await signIn(email);
    const url = '/v1/users/me';
    const key = { 'idempotency-key': `profile-${randomUUID()}` };

    const missingCsrf = await send('PATCH', url, {
      headers: { cookie: browser.cookie, ...key },
      payload: { displayName: 'Ada Lovelace', expectedRevision: 1 },
    });
    expect(missingCsrf.statusCode).toBe(403);
    const invalid = await send('PATCH', url, {
      browser,
      headers: key,
      payload: { displayName: 'Ada\nLovelace', expectedRevision: 1 },
    });
    expect(invalid.statusCode).toBe(400);
    const renamed = await send('PATCH', url, {
      browser,
      headers: key,
      payload: { displayName: ' Ada Lovelace ', expectedRevision: 1 },
    });
    expect(renamed.statusCode, renamed.payload).toBe(200);
    expect(renamed.json()).toMatchObject({
      profile: { displayName: 'Ada Lovelace', revision: 2 },
      changed: true,
      replayed: false,
    });
    const replay = await send('PATCH', url, {
      browser,
      headers: key,
      payload: { displayName: ' Ada Lovelace ', expectedRevision: 1 },
    });
    expect(replay.json()).toMatchObject({ replayed: true });
    const stale = await send('PATCH', url, {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { displayName: 'Someone Else', expectedRevision: 1 },
    });
    expectProblem(stale, 412, 'user.profile_revision_conflict');
    const current = await send('GET', url, { browser });
    expect(current.json()).toMatchObject({
      email,
      displayName: 'Ada Lovelace',
      revision: 2,
    });
  });

  it('accepts an invitation from a fresh sign-in, removes the member and lets them rejoin', async () => {
    const ownerEmail = `${randomUUID()}@example.test`;
    const recipientEmail = `${randomUUID()}@example.test`;
    await signUp(ownerEmail, '/login?verified=true');
    await signUp(recipientEmail, '/login?verified=true');
    const owner = await signIn(ownerEmail);
    const created = await send('POST', '/v1/workspaces', {
      browser: owner,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Better Auth team',
        slug: `ba-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(created.statusCode, created.payload).toBe(201);
    const workspaceId = created.json<{ id: string }>().id;

    const staleRecipient = await signIn(recipientEmail);
    const { journey, bound } = await openInvitation(
      owner,
      workspaceId,
      recipientEmail,
      staleRecipient,
    );
    const legacyRoute = await send('POST', '/v1/invitation-acceptance/oidc', {
      browser: bound,
      headers: { 'x-invitation-csrf-token': journey.csrfToken },
      payload: {},
    });
    expect(legacyRoute.statusCode).toBe(404);
    await admin.query(
      `update app.auth_sessions set created_at=created_at-interval '10 minutes'
        where user_id=(select id from app.users where email=$1)`,
      [recipientEmail],
    );
    const stale = await verifySession(bound, journey.csrfToken);
    expectProblem(stale, 409, 'workspace.invitation_proof_expired');

    const fresh = await signIn(recipientEmail);
    const freshBound: Browser = {
      ...fresh,
      cookie: `${fresh.cookie}; ${bound.cookie.split('; ').at(-1) ?? ''}`,
    };
    const ready = await verifySession(freshBound, journey.csrfToken);
    expect(ready.statusCode, ready.payload).toBe(200);
    const readyJourney = ready.json<{
      state: string;
      intentId: string;
      invitationRevision: number;
    }>();
    expect(readyJourney.state).toBe('ready');
    const completed = await send('POST', '/v1/invitation-acceptance/complete', {
      browser: freshBound,
      headers: {
        'idempotency-key': randomUUID(),
        'x-invitation-csrf-token': journey.csrfToken,
      },
      payload: {
        intentId: readyJourney.intentId,
        expectedRevision: readyJourney.invitationRevision,
      },
    });
    expect(completed.statusCode, completed.payload).toBe(200);
    expect(completed.json()).toMatchObject({
      workspaceId,
      role: 'viewer',
      membershipCreated: true,
    });
    const member = browserFrom(completed);
    expect(
      (await send('GET', '/v1/users/me', { browser: fresh })).statusCode,
    ).toBe(401);
    const memberId = (
      await send('GET', '/v1/users/me', { browser: member })
    ).json<{ id: string }>().id;

    const removeUrl = `/v1/workspaces/${workspaceId}/members/${memberId}/remove`;
    const removeKey = { 'idempotency-key': `remove-${randomUUID()}` };
    const withoutCsrf = await send('POST', removeUrl, {
      headers: { cookie: owner.cookie, ...removeKey },
      payload: { expectedRoleRevision: 1 },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    const strict = await send('POST', removeUrl, {
      browser: owner,
      headers: removeKey,
      payload: { expectedRoleRevision: 1, role: 'viewer' },
    });
    expect(strict.statusCode).toBe(400);
    const staleRemoval = await send('POST', removeUrl, {
      browser: owner,
      headers: { 'idempotency-key': randomUUID() },
      payload: { expectedRoleRevision: 2 },
    });
    expectProblem(staleRemoval, 409, 'workspace.member_role_revision_conflict');
    const selfRemoval = await send(
      'POST',
      `/v1/workspaces/${workspaceId}/members/${memberId}/remove`,
      {
        browser: member,
        headers: { 'idempotency-key': randomUUID() },
        payload: { expectedRoleRevision: 1 },
      },
    );
    expect(selfRemoval.statusCode).toBe(403);
    const removed = await send('POST', removeUrl, {
      browser: owner,
      headers: removeKey,
      payload: { expectedRoleRevision: 1 },
    });
    expect(removed.statusCode, removed.payload).toBe(200);
    expect(removed.json()).toEqual({
      userId: memberId,
      roleRevision: 2,
      replayed: false,
    });
    const replayed = await send('POST', removeUrl, {
      browser: owner,
      headers: removeKey,
      payload: { expectedRoleRevision: 1 },
    });
    expect(replayed.json()).toMatchObject({ replayed: true });
    expect(
      (await send('GET', '/v1/users/me', { browser: member })).statusCode,
    ).toBe(401);
    const again = await send('POST', removeUrl, {
      browser: owner,
      headers: { 'idempotency-key': randomUUID() },
      payload: { expectedRoleRevision: 2 },
    });
    expectProblem(again, 409, 'workspace.member_removal_conflict');
    const members = await send('GET', `/v1/workspaces/${workspaceId}/members`, {
      browser: owner,
    });
    expect(
      members
        .json<{ items: { userId: string }[] }>()
        .items.map((item) => item.userId),
    ).not.toContain(memberId);

    const returning = await signIn(recipientEmail);
    const reopened = await openInvitation(
      owner,
      workspaceId,
      recipientEmail,
      returning,
    );
    const reverified = await verifySession(
      reopened.bound,
      reopened.journey.csrfToken,
    );
    const reverifiedJourney = reverified.json<{
      intentId: string;
      invitationRevision: number;
    }>();
    const rejoined = await send('POST', '/v1/invitation-acceptance/complete', {
      browser: reopened.bound,
      headers: {
        'idempotency-key': randomUUID(),
        'x-invitation-csrf-token': reopened.journey.csrfToken,
      },
      payload: {
        intentId: reverifiedJourney.intentId,
        expectedRevision: reverifiedJourney.invitationRevision,
      },
    });
    expect(rejoined.json()).toMatchObject({
      membershipCreated: true,
      role: 'viewer',
    });
    const workspaces = await send('GET', '/v1/workspaces', {
      browser: browserFrom(rejoined),
    });
    expect(workspaces.json()).toMatchObject({
      items: [{ id: workspaceId, role: 'viewer' }],
    });
  });

  function verifySession(browser: Browser, csrfToken: string) {
    return send('POST', '/v1/invitation-acceptance/session', {
      browser,
      headers: { 'x-invitation-csrf-token': csrfToken },
      payload: {},
    });
  }
});

function apiConfig(): ApiConfig {
  return {
    database: databaseConfig,
    host: '127.0.0.1',
    identity: {
      publicWebOrigin: origin,
      invitationTokenEncryption: invitationKeys,
      session: { ttlMillis: 3_600_000, secureCookie: false, sameSite: 'lax' },
      betterAuth: {
        secret: 'better-auth-only-integration-secret-with-32-plus-characters',
        mailMode: 'local',
        providers: {},
      },
    },
    nodeCompatibilityCohort: 'core',
    nodeEnv: 'test',
    observability: {
      environment: 'test',
      logLevel: 'silent',
      otlpHeaders: {},
      serviceName: 'pertexo-api',
      serviceVersion: 'better-auth-integration',
    },
    port: 3000,
    redisUrl,
  };
}

function setCookies(reply: Reply): string[] {
  const header = reply.headers['set-cookie'];
  return Array.isArray(header) ? header : [header ?? ''];
}

function setCookie(reply: Reply, name: string): string {
  const cookie = setCookies(reply).find((value) =>
    value.startsWith(`${name}=`),
  );
  const value = cookie?.split(';', 1)[0]?.slice(name.length + 1);
  if (value === undefined || value === '')
    throw new Error(`${name} cookie was not returned`);
  return value;
}

function browserFrom(reply: Reply): Browser {
  const session = setCookie(reply, 'pertexo_session');
  const csrf = decodeURIComponent(setCookie(reply, 'pertexo_csrf'));
  return {
    session,
    csrf,
    cookie: `pertexo_session=${session}; pertexo_csrf=${encodeURIComponent(csrf)}`,
  };
}

function expectProblem(reply: Reply, status: number, code: string): void {
  expect(reply.statusCode, reply.payload).toBe(status);
  expect(reply.json()).toMatchObject({ status, code });
}
