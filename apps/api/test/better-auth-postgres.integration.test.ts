import { createHash, randomUUID } from 'node:crypto';

import {
  createAuthenticationMailEnqueueStore,
  createOidcLoginTransactionStore,
} from '@pertexo/database/api';
import { migrateDatabase } from '@pertexo/database/testing';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createBetterAuthRuntime,
  type BetterAuthRuntime,
} from '../src/identity-infrastructure/better-auth.js';
import type { LinkProviderGateway } from '../src/identity-infrastructure/account-linking.js';
import { createOidcSecretEncryptionAdapter } from '../src/identity-infrastructure/oidc-secret-encryption.js';
import type {
  OidcAuthorizationRequest,
  OidcProviderPort,
} from '../src/identity/index.js';
import {
  DurableAuthenticationMail,
  LocalAuthenticationMailSink,
  authenticationMailAssociatedData,
} from '../src/identity-infrastructure/authentication-mail.js';
import { registerBetterAuthHandler } from '../src/identity-infrastructure/better-auth-fastify.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const databaseName = `pertexo_test_auth_${randomUUID().replaceAll('-', '')}`;

function databaseUrl(base: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Expected integration fixture value');
  return value;
}

const migrationUrl = databaseUrl(migrationBaseUrl);
const apiUrl = databaseUrl(apiBaseUrl);
const workerUrl = databaseUrl(workerBaseUrl);
const mail = new LocalAuthenticationMailSink();
let runtime: BetterAuthRuntime;

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: migrationUrl,
    dispatcherRole: 'pertexo_dispatcher',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    maintenanceRole: 'pertexo_maintenance',
    operatorRole: 'pertexo_operator',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
  runtime = createBetterAuthRuntime({
    baseUrl: 'http://pertexo.test',
    secret: 'postgres-integration-secret-with-at-least-32-characters',
    database: {
      connectionString: apiUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 2,
    },
    secureCookies: false,
    sessionTtlSeconds: 3_600,
    trustedOrigins: ['http://pertexo.test'],
    mail,
  });
}, 60_000);

afterAll(async () => {
  await runtime.close();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`drop database if exists "${databaseName}"`);
  } finally {
    await admin.end();
  }
});

describe('Better Auth PostgreSQL cutover', () => {
  it('migrates only an exact legacy issuer/subject after a second provider proof', async () => {
    const userId = randomUUID();
    const identityId = randomUUID();
    const email = `legacy-${randomUUID()}@example.test`;
    const issuer = 'https://legacy-identity.example.test';
    const subject = `broker-${randomUUID()}`;
    const admin = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    await admin.query(
      `insert into app.users(id,email,display_name,email_verified)
       values($1,$2,'Legacy User',true)`,
      [userId, email],
    );
    await admin.query(
      `insert into app.auth_identities(id,user_id,issuer,provider_subject)
       values($1,$2,$3,$4)`,
      [identityId, userId, issuer, subject],
    );
    const oldSessionId = randomUUID();
    await admin.query(
      `insert into app.sessions(id,user_id,token_digest,expires_at)
       values($1,$2,$3,clock_timestamp()+interval '1 hour')`,
      [
        oldSessionId,
        userId,
        createHash('sha256').update(oldSessionId).digest('hex'),
      ],
    );
    const legacyAuthorizations = new Map<string, OidcAuthorizationRequest>();
    const oldProvider: OidcProviderPort = {
      authorizationUrl: (request) => {
        legacyAuthorizations.set(request.state, request);
        return `https://legacy-identity.example.test/authorize?state=${request.state}`;
      },
      exchangeCode: ({ code, codeVerifier, redirectUri }) => {
        const state = code.split(':', 2)[1] ?? '';
        const expected = legacyAuthorizations.get(state);
        if (
          expected?.redirectUri !== redirectUri ||
          expected.codeChallenge !==
            createHash('sha256').update(codeVerifier).digest('base64url')
        )
          throw new Error('Invalid old provider code');
        return Promise.resolve({
          issuer,
          subject: code.startsWith('unknown:') ? 'unknown' : subject,
          audience: 'legacy-migration-fixture',
          nonce: expected.nonce,
          email,
          displayName: 'Legacy User',
          emailVerified: true,
        });
      },
    };
    const providerAuthorizations = new Map<
      string,
      { codeVerifier: string; nonce: string }
    >();
    const newProvider: LinkProviderGateway = {
      available: ['google'],
      authorize: (input) => {
        providerAuthorizations.set(input.state, input);
        return Promise.resolve(
          `https://new-provider.example.test/authorize?state=${input.state}`,
        );
      },
      verify: (input) => {
        const state = input.code.split(':', 2)[1] ?? '';
        const expected = providerAuthorizations.get(state);
        if (
          expected?.codeVerifier !== input.codeVerifier ||
          expected.nonce !== input.nonce ||
          input.issuer !== null
        )
          return Promise.resolve(undefined);
        return Promise.resolve({
          accountId: `direct-google-${randomUUID()}`,
          email,
          emailVerified: true,
        });
      },
    };
    const transactions = createOidcLoginTransactionStore(
      {
        connectionString: apiUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      createOidcSecretEncryptionAdapter({
        current: {
          version: 'fixture-v1',
          key: Buffer.alloc(32, 0x4c).toString('base64'),
        },
      }),
    );
    const migrationRuntime = createBetterAuthRuntime({
      baseUrl: 'http://pertexo.test',
      secret: 'postgres-integration-secret-with-at-least-32-characters',
      database: {
        connectionString: apiUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        max: 2,
      },
      secureCookies: false,
      sessionTtlSeconds: 3_600,
      trustedOrigins: ['http://pertexo.test'],
      mail,
      linkProviderGateway: newProvider,
      legacyOidc: {
        configuration: {
          issuer,
          authorizationEndpoint: `${issuer}/authorize`,
          clientId: 'legacy-migration-fixture',
          redirectUri:
            'http://pertexo.test/v1/auth/legacy-migration/oidc/callback',
          scopes: ['openid', 'email'],
          transactionTtlMillis: 300_000,
        },
        transactions,
        provider: oldProvider,
      },
    });
    const browserRequest = (
      path: string,
      method: 'GET' | 'POST',
      cookies = '',
      body?: object,
    ) =>
      migrationRuntime.auth.handler(
        new Request(`http://pertexo.test${path}`, {
          method,
          headers: {
            origin: 'http://pertexo.test',
            cookie: cookies,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    try {
      const started = await browserRequest(
        '/v1/auth/legacy-migration/start',
        'POST',
        '',
        { provider: 'google' },
      );
      expect(started.status).toBe(200);
      const browserCookie = started.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('pertexo_legacy_migration='))
        ?.split(';', 1)[0];
      const oidcCookie = started.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('pertexo_legacy_oidc='))
        ?.split(';', 1)[0];
      expect(browserCookie).toBeDefined();
      expect(oidcCookie).toBeDefined();
      const oldUrl = new URL(
        ((await started.json()) as { authorizationUrl: string })
          .authorizationUrl,
      );
      const oldState = required(oldUrl.searchParams.get('state'));
      const oldCallback = `/v1/auth/legacy-migration/oidc/callback?state=${oldState}&code=legacy:${oldState}`;
      const wrongBrowser = await browserRequest(
        oldCallback,
        'GET',
        `${required(oidcCookie)}; pertexo_legacy_migration=wrong`,
      );
      expect(wrongBrowser.headers.get('location')).toContain(
        'migration_failed',
      );
      const provedOld = await browserRequest(
        oldCallback,
        'GET',
        `${required(browserCookie)}; ${required(oidcCookie)}`,
      );
      expect(provedOld.status).toBe(302);
      const targetUrl = new URL(
        provedOld.headers.get('location') ?? 'http://invalid',
      );
      expect(targetUrl.hostname).toBe('new-provider.example.test');
      const targetState = required(targetUrl.searchParams.get('state'));
      const targetCallback = `/v1/auth/legacy-migration/provider/callback/google?state=${targetState}&code=new:${targetState}`;
      const [first, second] = await Promise.all([
        browserRequest(targetCallback, 'GET', browserCookie),
        browserRequest(targetCallback, 'GET', browserCookie),
      ]);
      const outcomes = [
        first.headers.get('location'),
        second.headers.get('location'),
      ];
      expect(
        outcomes.filter((location) => location?.endsWith('/workspaces')),
      ).toHaveLength(1);
      expect(
        outcomes.filter((location) => location?.includes('migration_failed')),
      ).toHaveLength(1);
      const accepted = outcomes[0]?.endsWith('/workspaces') ? first : second;
      const newCookie = cookieValue(accepted.headers.getSetCookie());
      expect(newCookie).toBeDefined();
      expect(
        (await migrationRuntime.sessions.authenticate(newCookie ?? ''))?.userId,
      ).toBe(userId);
      const replay = await browserRequest(targetCallback, 'GET', browserCookie);
      expect(replay.headers.get('location')).toContain('migration_failed');
      const durable = await admin.query<{
        accounts: number;
        audits: number;
        sessions: number;
        old_revoked: boolean;
        migrated: boolean;
      }>(
        `select
          (select count(*)::integer from app.auth_accounts where user_id=$1) accounts,
          (select count(*)::integer from app.identity_security_audit_facts
            where user_id=$1 and event_type='legacy.method_migrated') audits,
          (select count(*)::integer from app.auth_sessions where user_id=$1) sessions,
          (select revoked_at is not null from app.sessions where id=$2) old_revoked,
          (select native_method_verified_at is not null from app.auth_identities where id=$3) migrated`,
        [userId, oldSessionId, identityId],
      );
      expect(durable.rows).toEqual([
        {
          accounts: 1,
          audits: 1,
          sessions: 1,
          old_revoked: true,
          migrated: true,
        },
      ]);
    } finally {
      await migrationRuntime.close();
      await transactions.close();
      await admin.end();
    }
  });

  it('links a fixture provider only after a fresh existing-method proof and rotates the session once', async () => {
    const email = `linked-${randomUUID()}@example.test`;
    const password = 'correct horse battery staple';
    const signup = await authRequest('/v1/auth/sign-up/email', {
      name: 'Linking Test',
      email,
      password,
    });
    expect(signup.status).toBe(200);
    const verification = mail
      .readForTesting(email)
      .find((item) => item.purpose === 'verification');
    expect(verification).toBeDefined();
    expect(
      (
        await runtime.auth.handler(
          new Request(verification?.url ?? 'http://invalid'),
        )
      ).status,
    ).toBe(302);
    const signIn = await authRequest('/v1/auth/sign-in/email', {
      email,
      password,
    });
    expect(signIn.status).toBe(200);
    const originalCookie = cookieValue(signIn.headers.getSetCookie());
    expect(originalCookie).toBeDefined();

    const authorizations = new Map<
      string,
      { codeVerifier: string; nonce: string; redirectUri: string }
    >();
    const gateway: LinkProviderGateway = {
      available: ['google', 'github'],
      authorize: (input) => {
        authorizations.set(`${input.provider}:${input.state}`, input);
        return Promise.resolve(
          `https://provider.test/authorize?state=${input.state}`,
        );
      },
      verify: (input) => {
        const state = input.code.split(':', 2)[1] ?? '';
        const expected = authorizations.get(`${input.provider}:${state}`);
        if (
          expected?.codeVerifier !== input.codeVerifier ||
          expected.nonce !== input.nonce ||
          expected.redirectUri !== input.redirectUri ||
          input.issuer !== null
        )
          return Promise.resolve(undefined);
        return Promise.resolve({
          accountId: `${input.provider}-subject-${email}`,
          email,
          emailVerified: true,
        });
      },
    };
    const linkingRuntime = createBetterAuthRuntime({
      baseUrl: 'http://pertexo.test',
      secret: 'postgres-integration-secret-with-at-least-32-characters',
      database: {
        connectionString: apiUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        max: 2,
      },
      secureCookies: false,
      sessionTtlSeconds: 3_600,
      trustedOrigins: ['http://pertexo.test'],
      mail,
      linkProviderGateway: gateway,
    });
    const csrf = 'link-csrf-token-with-more-than-thirty-two-characters';
    const linkRequest = (
      path: string,
      method: 'GET' | 'POST',
      session: string,
      binding?: string,
      body?: object,
    ) =>
      linkingRuntime.auth.handler(
        new Request(`http://pertexo.test${path}`, {
          method,
          headers: {
            origin: 'http://pertexo.test',
            cookie: `pertexo_session=${session}; pertexo_csrf=${csrf}${binding === undefined ? '' : `; pertexo_link=${binding}`}`,
            'x-csrf-token': csrf,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    try {
      const wrongPassword = await linkRequest(
        '/v1/auth/account-security/methods/link/start',
        'POST',
        originalCookie ?? '',
        undefined,
        {
          provider: 'google',
          existingMethod: { kind: 'password', password: 'wrong' },
        },
      );
      expect(wrongPassword.status).toBe(403);
      const started = await linkRequest(
        '/v1/auth/account-security/methods/link/start',
        'POST',
        originalCookie ?? '',
        undefined,
        { provider: 'google', existingMethod: { kind: 'password', password } },
      );
      expect(started.status).toBe(200);
      const binding = started.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('pertexo_link='))
        ?.slice('pertexo_link='.length)
        .split(';', 1)[0];
      expect(binding).toBeDefined();
      const startedBody = (await started.json()) as {
        authorizationUrl: string;
      };
      const state = required(
        new URL(startedBody.authorizationUrl).searchParams.get('state'),
      );
      expect(state).toBeTruthy();
      const callback = `/v1/auth/account-security/methods/link/callback/google?state=${state}&code=valid:${state}`;
      const otherBrowser = await linkRequest(
        callback,
        'GET',
        originalCookie ?? '',
        'wrong-binding',
      );
      expect(otherBrowser.headers.get('location')).toContain('linkError=true');

      const [first, second] = await Promise.all([
        linkRequest(callback, 'GET', originalCookie ?? '', binding),
        linkRequest(callback, 'GET', originalCookie ?? '', binding),
      ]);
      const outcomes = [
        first.headers.get('location'),
        second.headers.get('location'),
      ];
      expect(
        outcomes.filter((location) => location?.includes('linked=true')),
      ).toHaveLength(1);
      expect(
        outcomes.filter((location) => location?.includes('linkError=true')),
      ).toHaveLength(1);
      const accepted = outcomes[0]?.includes('linked=true') ? first : second;
      const replacementCookie = cookieValue(accepted.headers.getSetCookie());
      expect(replacementCookie).toBeDefined();
      expect(
        await runtime.sessions.authenticate(originalCookie ?? ''),
      ).toBeUndefined();
      expect(
        await runtime.sessions.authenticate(replacementCookie ?? ''),
      ).toBeDefined();
      const replay = await linkRequest(
        callback,
        'GET',
        replacementCookie ?? '',
        binding,
      );
      expect(replay.headers.get('location')).toContain('linkError=true');

      const admin = new Pool({
        connectionString: databaseUrl(adminUrl),
        max: 1,
      });
      try {
        const state = await admin.query<{
          accounts: number;
          audits: number;
          sessions: number;
        }>(
          `select
             (select count(*)::integer from app.auth_accounts account
               join app.users users on users.id=account.user_id
               where users.email=$1 and account.provider_id='google') accounts,
             (select count(*)::integer from app.identity_security_audit_facts audit
               join app.users users on users.id=audit.user_id
               where users.email=$1 and audit.event_type='method.linked') audits,
             (select count(*)::integer from app.auth_sessions session
               join app.users users on users.id=session.user_id
               where users.email=$1) sessions`,
          [email],
        );
        expect(state.rows).toEqual([{ accounts: 1, audits: 1, sessions: 1 }]);
      } finally {
        await admin.end();
      }

      const secondStart = await linkRequest(
        '/v1/auth/account-security/methods/link/start',
        'POST',
        replacementCookie ?? '',
        undefined,
        {
          provider: 'github',
          existingMethod: { kind: 'social', provider: 'google' },
        },
      );
      expect(secondStart.status).toBe(200);
      const secondBinding = secondStart.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('pertexo_link='))
        ?.slice('pertexo_link='.length)
        .split(';', 1)[0];
      const sourceUrl = new URL(
        ((await secondStart.json()) as { authorizationUrl: string })
          .authorizationUrl,
      );
      const sourceState = required(sourceUrl.searchParams.get('state'));
      const sourceCallback = await linkRequest(
        `/v1/auth/account-security/methods/link/callback/google?state=${sourceState}&code=valid:${sourceState}`,
        'GET',
        replacementCookie ?? '',
        secondBinding,
      );
      expect(sourceCallback.status).toBe(302);
      const targetUrl = new URL(
        sourceCallback.headers.get('location') ?? 'http://invalid',
      );
      expect(targetUrl.hostname).toBe('provider.test');
      const targetState = required(targetUrl.searchParams.get('state'));
      const targetCallback = await linkRequest(
        `/v1/auth/account-security/methods/link/callback/github?state=${targetState}&code=valid:${targetState}`,
        'GET',
        replacementCookie ?? '',
        secondBinding,
      );
      expect(targetCallback.headers.get('location')).toContain('linked=true');
      const secondReplacementCookie = cookieValue(
        targetCallback.headers.getSetCookie(),
      );
      expect(secondReplacementCookie).toBeDefined();
      expect(
        await runtime.sessions.authenticate(replacementCookie ?? ''),
      ).toBeUndefined();
      expect(
        await runtime.sessions.authenticate(secondReplacementCookie ?? ''),
      ).toBeDefined();
    } finally {
      await linkingRuntime.close();
    }
  });

  it('carries a real PostgreSQL signup and sign-in through the mounted HTTP guard', async () => {
    const application = Fastify();
    registerBetterAuthHandler(application, {
      handler: runtime.auth.handler,
      rateLimitConsumer: {
        consume: () => Promise.resolve({ allowed: true as const }),
      },
      publicOrigin: 'http://pertexo.test',
      sessionCookie: {
        secure: false,
        sameSite: 'lax',
        maxAgeSeconds: 3_600,
      },
    });
    const email = `http-guard-${randomUUID()}@example.test`;
    try {
      const forbidden = await application.inject({
        method: 'POST',
        url: '/v1/auth/sign-up/email',
        headers: { origin: 'http://other.test' },
        payload: {
          name: 'Guarded Signup',
          email,
          password: 'correct horse battery staple',
        },
      });
      expect(forbidden.statusCode).toBe(403);

      const signup = await application.inject({
        method: 'POST',
        url: '/v1/auth/sign-up/email',
        headers: { origin: 'http://pertexo.test' },
        payload: {
          name: 'Guarded Signup',
          email,
          password: 'correct horse battery staple',
        },
      });
      expect(signup.statusCode).toBe(200);
      expect(signup.json()).not.toHaveProperty('token');
      const proofInspector = new Pool({
        connectionString: databaseUrl(adminUrl),
        max: 1,
      });
      try {
        const proofs = await proofInspector.query<{ count: number }>(
          `select count(*)::integer count from app.auth_email_proofs proof
             join app.users users on users.id=proof.user_id
            where users.email=$1`,
          [email],
        );
        expect(proofs.rows[0]?.count).toBe(1);
      } finally {
        await proofInspector.end();
      }
      const verification = mail
        .readForTesting(email)
        .find((message) => message.purpose === 'verification');
      expect(verification).toBeDefined();
      const link = new URL(verification?.url ?? 'http://invalid');
      const verified = await application.inject({
        method: 'GET',
        url: `${link.pathname}${link.search}`,
        headers: { origin: 'http://pertexo.test' },
      });
      expect([200, 302]).toContain(verified.statusCode);
      const signIn = await application.inject({
        method: 'POST',
        url: '/v1/auth/sign-in/email',
        headers: { origin: 'http://pertexo.test' },
        payload: { email, password: 'correct horse battery staple' },
      });
      expect(signIn.statusCode).toBe(200);
      expect(signIn.json()).not.toHaveProperty('token');
      const cookies = signIn.headers['set-cookie'];
      const session = cookieValue(
        typeof cookies === 'string' ? [cookies] : (cookies ?? []),
      );
      expect(session).toBeDefined();
      expect(await runtime.sessions.authenticate(session ?? '')).toBeDefined();

      const replay = await application.inject({
        method: 'GET',
        url: `${link.pathname}${link.search}`,
        headers: { origin: 'http://pertexo.test' },
      });
      expect(replay.headers['set-cookie']).toBeUndefined();
      expect([400, 302]).toContain(replay.statusCode);
      if (replay.statusCode === 302)
        expect(replay.headers.location).toContain('error=');
      const nativeToken = await application.inject({
        method: 'GET',
        url: '/v1/auth/verify-email?token=header.payload.signature',
        headers: { origin: 'http://pertexo.test' },
      });
      expect(nativeToken.headers.location).toContain(
        'error=verification_invalid',
      );
    } finally {
      await application.close();
    }
  });

  it('commits encrypted authentication mail before acknowledging enqueue', async () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key },
    });
    const store = createAuthenticationMailEnqueueStore({
      connectionString: apiUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      const mailer = new DurableAuthenticationMail(
        store,
        envelope,
        'security@example.test',
      );
      await mailer.sendPasswordReset({
        recipient: 'secret-recipient@example.test',
        displayName: 'Ada',
        url: 'https://pertexo.test/reset-password?token=secret-link',
      });
      const stored = await owner.query<{
        id: string;
        purpose: string;
        expires_at: Date;
        payload_ciphertext: string;
        payload_nonce: string;
        payload_tag: string;
        payload_key_version: string;
      }>(
        `select id,purpose,expires_at,payload_ciphertext,payload_nonce,
                payload_tag,payload_key_version
           from app.authentication_mail_deliveries
          where purpose='password_reset'
          order by created_at desc limit 1`,
      );
      const row = stored.rows[0];
      expect(row).toBeDefined();
      if (row === undefined) throw new Error('Durable mail row is missing');
      expect(JSON.stringify(row)).not.toContain(
        'secret-recipient@example.test',
      );
      expect(JSON.stringify(row)).not.toContain('secret-link');
      const rotated = createApplicationSecretEnvelope({
        current: {
          version: 'v2',
          key: Buffer.alloc(32, 10).toString('base64'),
        },
        previous: [{ version: 'v1', key }],
      });
      expect(
        rotated.open(
          {
            ciphertext: row.payload_ciphertext,
            nonce: row.payload_nonce,
            tag: row.payload_tag,
            keyVersion: row.payload_key_version,
          },
          authenticationMailAssociatedData(row.purpose, row.id, row.expires_at),
        ),
      ).toContain('secret-link');
    } finally {
      await Promise.all([store.close(), owner.end()]);
    }
  });

  it('commits the owned proof and sealed verification mail together', async () => {
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 17).toString('base64') },
    });
    const store = createAuthenticationMailEnqueueStore({
      connectionString: apiUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    const durable = createBetterAuthRuntime({
      baseUrl: 'http://pertexo.test',
      secret: 'durable-proof-integration-secret-at-least-32-characters',
      database: {
        connectionString: apiUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        max: 2,
      },
      secureCookies: false,
      sessionTtlSeconds: 3_600,
      trustedOrigins: ['http://pertexo.test'],
      mail: new DurableAuthenticationMail(
        store,
        envelope,
        'security@example.test',
      ),
    });
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const email = `durable-proof-${randomUUID()}@example.test`;
    try {
      const signup = await durable.auth.handler(
        new Request('http://pertexo.test/v1/auth/sign-up/email', {
          method: 'POST',
          headers: {
            origin: 'http://pertexo.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Durable Proof',
            email,
            password: 'correct horse battery staple',
          }),
        }),
      );
      expect(signup.status).toBe(200);
      const stored = await owner.query<{
        id: string;
        expires_at: Date;
        payload_ciphertext: string;
        payload_nonce: string;
        payload_tag: string;
        payload_key_version: string;
      }>(`select mail.id,mail.expires_at,mail.payload_ciphertext,
               mail.payload_nonce,mail.payload_tag,mail.payload_key_version
            from app.authentication_mail_deliveries mail
           where mail.purpose='verification'
           order by mail.created_at desc limit 1`);
      const row = stored.rows[0];
      expect(row).toBeDefined();
      expect(row?.payload_ciphertext).not.toContain(email);
      const payload = JSON.parse(
        envelope.open(
          {
            ciphertext: row?.payload_ciphertext ?? '',
            nonce: row?.payload_nonce ?? '',
            tag: row?.payload_tag ?? '',
            keyVersion: row?.payload_key_version ?? '',
          },
          authenticationMailAssociatedData(
            'verification',
            row?.id ?? '',
            row?.expires_at ?? new Date(),
          ),
        ),
      ) as {
        toEmail: string;
        text: string;
      };
      expect(payload.toEmail).toBe(email);
      const link = payload.text
        .split('\n')
        .find((line) =>
          line.startsWith('http://pertexo.test/v1/auth/verify-email?'),
        );
      expect(link).toBeDefined();
      const verified = await durable.auth.handler(
        new Request(link ?? 'http://invalid'),
      );
      expect(verified.headers.get('location')).toContain('verified=true');
      const replay = await durable.auth.handler(
        new Request(link ?? 'http://invalid'),
      );
      expect(replay.headers.get('location')).toContain(
        'error=verification_invalid',
      );
      const signedIn = await durable.auth.handler(
        new Request('http://pertexo.test/v1/auth/sign-in/email', {
          method: 'POST',
          headers: {
            origin: 'http://pertexo.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email,
            password: 'correct horse battery staple',
          }),
        }),
      );
      expect(signedIn.status).toBe(200);
      const session = cookieValue(signedIn.headers.getSetCookie());
      expect(session).toBeDefined();
      const csrf = 'd'.repeat(32);
      const newEmail = `changed-${email}`;
      const started = await durable.auth.handler(
        new Request('http://pertexo.test/v1/auth/change-email', {
          method: 'POST',
          headers: {
            origin: 'http://pertexo.test',
            'content-type': 'application/json',
            cookie: `pertexo_session=${session ?? ''}; pertexo_csrf=${csrf}`,
            'x-csrf-token': csrf,
          },
          body: JSON.stringify({ newEmail }),
        }),
      );
      expect(started.status).toBe(200);
      const readNewestMailLink = async (purpose: string): Promise<string> => {
        const latest = await owner.query<NonNullable<typeof row>>(
          `select id,expires_at,payload_ciphertext,payload_nonce,
                  payload_tag,payload_key_version
             from app.authentication_mail_deliveries
            where purpose=$1 order by created_at desc limit 1`,
          [purpose],
        );
        const message = latest.rows[0];
        expect(message).toBeDefined();
        const decoded = JSON.parse(
          envelope.open(
            {
              ciphertext: message?.payload_ciphertext ?? '',
              nonce: message?.payload_nonce ?? '',
              tag: message?.payload_tag ?? '',
              keyVersion: message?.payload_key_version ?? '',
            },
            authenticationMailAssociatedData(
              purpose,
              message?.id ?? '',
              message?.expires_at ?? new Date(),
            ),
          ),
        ) as { text: string };
        const found = decoded.text
          .split('\n')
          .find((line) =>
            line.startsWith('http://pertexo.test/v1/auth/verify-email?'),
          );
        expect(found).toBeDefined();
        return found ?? 'http://invalid';
      };
      const oldLink = await readNewestMailLink('email_change_confirmation');
      expect(
        (await durable.auth.handler(new Request(oldLink))).headers.get(
          'location',
        ),
      ).toContain('emailChangePending=true');
      const newLink = await readNewestMailLink('verification');
      expect(
        (await durable.auth.handler(new Request(newLink))).headers.get(
          'location',
        ),
      ).toContain('emailChanged=true');
      const changed = await owner.query<{ email_verified: boolean }>(
        'select email_verified from app.users where email=$1',
        [newEmail],
      );
      expect(changed.rows).toEqual([{ email_verified: true }]);
      await owner.query(`create function app.test_reject_proof_mail()
        returns trigger language plpgsql as $$
        begin raise exception 'test proof mail failure'; end; $$`);
      await owner.query(`create trigger test_reject_proof_mail
        before insert on app.authentication_mail_deliveries for each row
        execute function app.test_reject_proof_mail()`);
      const failedEmail = `failed-durable-proof-${randomUUID()}@example.test`;
      try {
        await expect(
          durable.auth.handler(
            new Request('http://pertexo.test/v1/auth/sign-up/email', {
              method: 'POST',
              headers: {
                origin: 'http://pertexo.test',
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                name: 'Undelivered Proof',
                email: failedEmail,
                password: 'correct horse battery staple',
              }),
            }),
          ),
        ).rejects.toThrow('test proof mail failure');
        const failedProofs = await owner.query<{ count: number }>(
          `select count(*)::integer count from app.auth_email_proofs proof
             join app.users users on users.id=proof.user_id
            where users.email=$1`,
          [failedEmail],
        );
        expect(failedProofs.rows).toEqual([{ count: 0 }]);
      } finally {
        await owner.query(
          'drop trigger if exists test_reject_proof_mail on app.authentication_mail_deliveries',
        );
        await owner.query(
          'drop function if exists app.test_reject_proof_mail()',
        );
      }
    } finally {
      await Promise.all([durable.close(), store.close(), owner.end()]);
    }
  });

  it('consumes initial verification once under concurrent clicks and rejects expiry', async () => {
    const concurrentEmail = `concurrent-proof-${randomUUID()}@example.test`;
    expect(
      (
        await authRequest('/v1/auth/sign-up/email', {
          name: 'Concurrent Proof',
          email: concurrentEmail,
          password: 'correct horse battery staple',
        })
      ).status,
    ).toBe(200);
    const link = mail
      .readForTesting(concurrentEmail)
      .find((message) => message.purpose === 'verification')?.url;
    expect(link).toBeDefined();
    const results = await Promise.all([
      followMailLink(link ?? 'http://invalid', ''),
      followMailLink(link ?? 'http://invalid', ''),
    ]);
    expect(
      results.map((response) => response.headers.get('location')).sort(),
    ).toEqual([
      'http://pertexo.test/login?error=verification_invalid',
      'http://pertexo.test/login?verified=true',
    ]);
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      const audited = await owner.query<{ count: number }>(
        `select count(*)::integer count from app.identity_security_audit_facts facts
           join app.users users on users.id=facts.user_id
          where users.email=$1 and facts.event_type='email.initial_verified'`,
        [concurrentEmail],
      );
      expect(audited.rows).toEqual([{ count: 1 }]);
      const expiredEmail = `expired-proof-${randomUUID()}@example.test`;
      expect(
        (
          await authRequest('/v1/auth/sign-up/email', {
            name: 'Expired Proof',
            email: expiredEmail,
            password: 'correct horse battery staple',
          })
        ).status,
      ).toBe(200);
      const expiredLink = mail
        .readForTesting(expiredEmail)
        .find((message) => message.purpose === 'verification')?.url;
      expect(expiredLink).toBeDefined();
      await owner.query(
        `update app.auth_email_proofs
            set created_at=clock_timestamp()-interval '2 hours',
                expires_at=clock_timestamp()-interval '1 hour'
          where user_id=(select id from app.users where email=$1)`,
        [expiredEmail],
      );
      const rejected = await followMailLink(
        expiredLink ?? 'http://invalid',
        '',
      );
      expect(rejected.headers.get('location')).toContain(
        'error=verification_invalid',
      );
      const unchanged = await owner.query<{ email_verified: boolean }>(
        'select email_verified from app.users where email=$1',
        [expiredEmail],
      );
      expect(unchanged.rows).toEqual([{ email_verified: false }]);
    } finally {
      await owner.end();
    }
  });

  it('rolls back proof consumption, email verification and audit when revocation fails', async () => {
    const email = `rollback-proof-${randomUUID()}@example.test`;
    expect(
      (
        await authRequest('/v1/auth/sign-up/email', {
          name: 'Rollback Proof',
          email,
          password: 'correct horse battery staple',
        })
      ).status,
    ).toBe(200);
    const link = mail
      .readForTesting(email)
      .find((message) => message.purpose === 'verification')?.url;
    expect(link).toBeDefined();
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(`create function app.test_reject_proof_revocation()
        returns trigger language plpgsql as $$
        begin raise exception 'test proof revocation failure'; end; $$`);
      await owner.query(`create trigger test_reject_proof_revocation
        before delete on app.auth_sessions for each statement
        execute function app.test_reject_proof_revocation()`);
      await expect(
        followMailLink(link ?? 'http://invalid', ''),
      ).rejects.toThrow('test proof revocation failure');
      const unchanged = await owner.query<{
        verified: boolean;
        consumed: boolean;
        audited: number;
      }>(
        `select users.email_verified verified,
               proof.consumed_at is not null consumed,
               (select count(*)::integer from app.identity_security_audit_facts audit
                 where audit.user_id=users.id) audited
            from app.users users join app.auth_email_proofs proof
              on proof.user_id=users.id where users.email=$1`,
        [email],
      );
      expect(unchanged.rows).toEqual([
        { verified: false, consumed: false, audited: 0 },
      ]);
    } finally {
      await owner.query(
        'drop trigger if exists test_reject_proof_revocation on app.auth_sessions',
      );
      await owner.query(
        'drop function if exists app.test_reject_proof_revocation()',
      );
      await owner.end();
    }
    const retry = await followMailLink(link ?? 'http://invalid', '');
    expect(retry.headers.get('location')).toContain('verified=true');
  });

  it('uses the stable user row, verifies email, issues one durable authority, and rejects suspended users', async () => {
    const signUp = await authRequest('/v1/auth/sign-up/email', {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      password: 'correct horse battery staple',
      callbackURL: '/login',
    });
    expect(signUp.status).toBe(200);
    expect(signUp.headers.getSetCookie()).toHaveLength(0);

    const verification = mail
      .readForTesting('ada@example.test')
      .find((message) => message.purpose === 'verification');
    expect(verification).toBeDefined();
    const verificationUrl = new URL(verification?.url ?? 'http://invalid');
    const verify = await runtime.auth.handler(
      new Request(verificationUrl, {
        headers: { origin: 'http://pertexo.test' },
        redirect: 'manual',
      }),
    );
    expect([200, 302]).toContain(verify.status);

    const signIn = await authRequest('/v1/auth/sign-in/email', {
      email: 'ada@example.test',
      password: 'correct horse battery staple',
      callbackURL: '/workspaces',
    });
    expect(signIn.status).toBe(200);
    const signInCookies = signIn.headers.getSetCookie();
    expect(signInCookies.map(cookieName)).toContain('pertexo_session');
    const signedCookie = cookieValue(signInCookies);
    expect(signedCookie).toBeDefined();
    const authenticated = await runtime.sessions.authenticate(
      signedCookie ?? '',
    );
    expect(authenticated?.userId).toMatch(/^[0-9a-f-]{36}$/u);

    const secondSession = await runtime.sessions.issue(
      authenticated?.userId ?? '',
    );
    const secondCookie = cookieValue(secondSession.setCookies);
    expect(secondCookie).toBeDefined();
    const csrf = 'test-csrf-token-with-more-than-thirty-two-characters';
    const list = await authenticatedRequest(
      '/v1/auth/account-security/sessions',
      'GET',
      signedCookie ?? '',
      csrf,
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      items: { id: string; current: boolean; token?: string }[];
    };
    expect(listed.items).toHaveLength(2);
    expect(listed.items.every((session) => session.token === undefined)).toBe(
      true,
    );
    expect(listed.items.some((session) => session.current)).toBe(true);

    const missingCsrf = await authenticatedRequest(
      '/v1/auth/account-security/sessions/revoke',
      'POST',
      signedCookie ?? '',
      undefined,
      { sessionId: secondSession.sessionId },
    );
    expect(missingCsrf.status).toBe(403);
    expect(
      await runtime.sessions.authenticate(secondCookie ?? ''),
    ).toBeDefined();

    const revoke = await authenticatedRequest(
      '/v1/auth/account-security/sessions/revoke',
      'POST',
      signedCookie ?? '',
      csrf,
      { sessionId: secondSession.sessionId },
    );
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ revoked: true });
    expect(
      await runtime.sessions.authenticate(secondCookie ?? ''),
    ).toBeUndefined();

    const methods = await authenticatedRequest(
      '/v1/auth/account-security',
      'GET',
      signedCookie ?? '',
      csrf,
    );
    expect(methods.status).toBe(200);
    const methodsBody = (await methods.json()) as {
      methods: { id: string; kind: string; provider: string | null }[];
    };
    expect(methodsBody).toMatchObject({
      email: 'ada@example.test',
      emailVerified: true,
      methods: [{ kind: 'password', provider: null }],
    });
    const passwordMethodId = methodsBody.methods[0]?.id;

    const blockedLink = await authenticatedRequest(
      '/v1/auth/link-social',
      'POST',
      signedCookie ?? '',
      csrf,
      {
        provider: 'google',
        callbackURL: '/account/security',
        disableRedirect: true,
      },
    );
    expect(blockedLink.status).toBe(403);
    const afterBlockedLink = await authenticatedRequest(
      '/v1/auth/account-security',
      'GET',
      signedCookie ?? '',
      csrf,
    );
    expect(
      ((await afterBlockedLink.json()) as { methods: unknown[] }).methods,
    ).toHaveLength(1);

    const passwordChange = await authenticatedRequest(
      '/v1/auth/account-security/password/change',
      'POST',
      signedCookie ?? '',
      csrf,
      {
        currentPassword: 'correct horse battery staple',
        newPassword: 'another correct horse battery staple',
      },
    );
    expect(passwordChange.status).toBe(200);
    const replacementCookie = cookieValue(
      passwordChange.headers.getSetCookie(),
    );
    expect(replacementCookie).toBeDefined();
    expect(replacementCookie).not.toBe(signedCookie);
    expect(
      await runtime.sessions.authenticate(signedCookie ?? ''),
    ).toBeUndefined();
    expect(
      await runtime.sessions.authenticate(replacementCookie ?? ''),
    ).toBeDefined();

    const oldPassword = await authRequest('/v1/auth/sign-in/email', {
      email: 'ada@example.test',
      password: 'correct horse battery staple',
      callbackURL: '/workspaces',
    });
    expect(oldPassword.status).toBe(401);
    const newPassword = await authRequest('/v1/auth/sign-in/email', {
      email: 'ada@example.test',
      password: 'another correct horse battery staple',
      callbackURL: '/workspaces',
    });
    expect(newPassword.status).toBe(200);

    const lastMethod = await authenticatedRequest(
      '/v1/auth/account-security/methods/unlink',
      'POST',
      replacementCookie ?? '',
      csrf,
      { methodId: passwordMethodId },
    );
    expect(lastMethod.status).toBe(400);

    const socialMethodId = randomUUID();
    const setup = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await setup.query(
        `insert into app.auth_accounts
          (id,account_id,provider_id,user_id,created_at,updated_at)
         values($1,'google-subject','google',$2,clock_timestamp(),clock_timestamp())`,
        [socialMethodId, authenticated?.userId],
      );
    } finally {
      await setup.end();
    }
    const unlink = await authenticatedRequest(
      '/v1/auth/account-security/methods/unlink',
      'POST',
      replacementCookie ?? '',
      csrf,
      { methodId: socialMethodId },
    );
    expect(unlink.status).toBe(200);
    expect(await unlink.json()).toEqual({ unlinked: true });
    const auditReader = new Pool({
      connectionString: databaseUrl(adminUrl),
      max: 1,
    });
    try {
      const facts = await auditReader.query<{
        event_type: string;
        count: number;
      }>(
        `select event_type,count(*)::integer count
           from app.identity_security_audit_facts
          where user_id=$1 and event_type in ('method.unlinked','password.changed')
          group by event_type order by event_type`,
        [authenticated?.userId],
      );
      expect(facts.rows).toEqual([
        { event_type: 'method.unlinked', count: 1 },
        { event_type: 'password.changed', count: 1 },
      ]);
    } finally {
      await auditReader.end();
    }
    const unlinkCookie = cookieValue(unlink.headers.getSetCookie());
    expect(unlinkCookie).toBeDefined();
    expect(
      await runtime.sessions.authenticate(replacementCookie ?? ''),
    ).toBeUndefined();
    expect(
      await runtime.sessions.authenticate(unlinkCookie ?? ''),
    ).toBeDefined();

    const changeEmail = await authenticatedRequest(
      '/v1/auth/change-email',
      'POST',
      unlinkCookie ?? '',
      csrf,
      {
        newEmail: 'ada.new@example.test',
        callbackURL: '/login?emailChanged=true',
      },
    );
    expect(changeEmail.status).toBe(200);
    const oldAddressConfirmation = mail
      .readForTesting('ada@example.test')
      .find((message) => message.purpose === 'email_change_confirmation');
    expect(oldAddressConfirmation).toBeDefined();
    const confirmOld = await followMailLink(
      oldAddressConfirmation?.url ?? 'http://invalid',
      unlinkCookie ?? '',
    );
    expect([200, 302]).toContain(confirmOld.status);
    expect(confirmOld.headers.get('location')).toContain(
      'emailChangePending=true',
    );
    const newAddressVerification = mail
      .readForTesting('ada.new@example.test')
      .find((message) => message.purpose === 'verification');
    expect(newAddressVerification).toBeDefined();
    const replayOld = await followMailLink(
      oldAddressConfirmation?.url ?? 'http://invalid',
      unlinkCookie ?? '',
    );
    expect(replayOld.headers.get('location')).toContain(
      'error=verification_invalid',
    );
    expect(
      mail
        .readForTesting('ada.new@example.test')
        .filter((message) => message.purpose === 'verification'),
    ).toHaveLength(1);
    const verifyNew = await followMailLink(
      newAddressVerification?.url ?? 'http://invalid',
      unlinkCookie ?? '',
    );
    expect([200, 302]).toContain(verifyNew.status);
    expect(verifyNew.headers.get('location')).toContain('emailChanged=true');
    const replayNew = await followMailLink(
      newAddressVerification?.url ?? 'http://invalid',
      unlinkCookie ?? '',
    );
    expect(replayNew.headers.get('location')).toContain(
      'error=verification_invalid',
    );
    expect(
      await runtime.sessions.authenticate(unlinkCookie ?? ''),
    ).toBeUndefined();
    const newEmailSignIn = await authRequest('/v1/auth/sign-in/email', {
      email: 'ada.new@example.test',
      password: 'another correct horse battery staple',
      callbackURL: '/workspaces',
    });
    expect(newEmailSignIn.status).toBe(200);
    const newEmailCookie = cookieValue(newEmailSignIn.headers.getSetCookie());
    expect(newEmailCookie).toBeDefined();

    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const rows = await api.query<{
        id: string;
        token: string;
        email_verified: boolean;
      }>(
        `select sessions.id,sessions.token,users.email_verified
           from app.auth_sessions sessions
           join app.users users on users.id=sessions.user_id
          where users.email='ada.new@example.test'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows.every((row) => row.email_verified)).toBe(true);
      expect(rows.rows.every((row) => row.token !== signedCookie)).toBe(true);
      expect(rows.rows.every((row) => row.token !== replacementCookie)).toBe(
        true,
      );
      await api.query(
        `update app.users set status='suspended',updated_at=clock_timestamp()
          where email='ada.new@example.test'`,
      );
      const revoked = await api.query<{ count: number }>(
        `select count(*)::integer count
           from app.auth_sessions sessions
           join app.users users on users.id=sessions.user_id
          where users.email='ada.new@example.test'`,
      );
      expect(revoked.rows).toEqual([{ count: 0 }]);
    } finally {
      await api.end();
    }
    expect(
      await runtime.sessions.authenticate(newEmailCookie ?? ''),
    ).toBeUndefined();
  });

  it('rolls back a password change when session revocation fails', async () => {
    const email = 'rollback-password@example.test';
    const originalPassword = 'original correct horse battery staple';
    const newPassword = 'replacement correct horse battery staple';
    const signUp = await authRequest('/v1/auth/sign-up/email', {
      name: 'Rollback Test',
      email,
      password: originalPassword,
      callbackURL: '/login',
    });
    expect(signUp.status).toBe(200);
    const verification = mail
      .readForTesting(email)
      .find((message) => message.purpose === 'verification');
    expect(verification).toBeDefined();
    await runtime.auth.handler(
      new Request(verification?.url ?? 'http://invalid', {
        headers: { origin: 'http://pertexo.test' },
        redirect: 'manual',
      }),
    );
    const signIn = await authRequest('/v1/auth/sign-in/email', {
      email,
      password: originalPassword,
      callbackURL: '/workspaces',
    });
    expect(signIn.status).toBe(200);
    const signedCookie = cookieValue(signIn.headers.getSetCookie()) ?? '';
    const authenticated = await runtime.sessions.authenticate(signedCookie);
    expect(authenticated).toBeDefined();
    if (authenticated === undefined)
      throw new Error('Expected an authenticated session');

    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(`create function app.test_reject_auth_session_delete()
        returns trigger language plpgsql as $$
        begin
          if old.user_id::text=TG_ARGV[0] then
            raise exception 'test revocation failure';
          end if;
          return old;
        end;
        $$`);
      await owner.query(`create trigger test_reject_auth_session_delete
        before delete on app.auth_sessions for each row
        execute function app.test_reject_auth_session_delete('${authenticated.userId}')`);
      const rejected = await authenticatedRequest(
        '/v1/auth/account-security/password/change',
        'POST',
        signedCookie,
        'test-csrf-token-with-more-than-thirty-two-characters',
        { currentPassword: originalPassword, newPassword },
      );
      expect(rejected.status).toBeGreaterThanOrEqual(500);
      expect(await runtime.sessions.authenticate(signedCookie)).toBeDefined();
    } finally {
      await owner.query(
        'drop trigger if exists test_reject_auth_session_delete on app.auth_sessions',
      );
      await owner.query(
        'drop function if exists app.test_reject_auth_session_delete()',
      );
      await owner.end();
    }
    expect(
      (
        await authRequest('/v1/auth/sign-in/email', {
          email,
          password: originalPassword,
          callbackURL: '/workspaces',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await authRequest('/v1/auth/sign-in/email', {
          email,
          password: newPassword,
          callbackURL: '/workspaces',
        })
      ).status,
    ).toBe(401);
  });

  it('serializes competing password setup commands and revokes the old session once', async () => {
    const userId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(
        `insert into app.users(id,email,display_name,email_verified)
         values($1,'social-setup@example.test','Social Setup',true)`,
        [userId],
      );
      await owner.query(
        `insert into app.auth_accounts(id,account_id,provider_id,user_id)
         values($1,'provider-subject','google',$2)`,
        [randomUUID(), userId],
      );
    } finally {
      await owner.end();
    }
    const initial = await runtime.sessions.issue(userId);
    const cookie = cookieValue(initial.setCookies) ?? '';
    const csrf = 'test-csrf-token-with-more-than-thirty-two-characters';
    const results = await Promise.all([
      authenticatedRequest(
        '/v1/auth/account-security/password/setup',
        'POST',
        cookie,
        csrf,
        {
          newPassword: 'social setup secure password one',
        },
      ),
      authenticatedRequest(
        '/v1/auth/account-security/password/setup',
        'POST',
        cookie,
        csrf,
        {
          newPassword: 'social setup secure password two',
        },
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200);
    const replacement = cookieValue(winner?.headers.getSetCookie() ?? []);
    expect(await runtime.sessions.authenticate(cookie)).toBeUndefined();
    expect(
      await runtime.sessions.authenticate(replacement ?? ''),
    ).toBeDefined();

    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const accounts = await api.query<{ count: number }>(
        `select count(*)::integer count from app.auth_accounts
          where user_id=$1 and provider_id='credential'`,
        [userId],
      );
      expect(accounts.rows).toEqual([{ count: 1 }]);
      const active = await api.query<{ count: number }>(
        'select count(*)::integer count from app.auth_sessions where user_id=$1',
        [userId],
      );
      expect(active.rows).toEqual([{ count: 1 }]);
    } finally {
      await api.end();
    }
  });

  it('consumes reset proof with credential change and revocation in one commit', async () => {
    const email = 'atomic-reset@example.test';
    const initialPassword = 'atomic reset original password';
    const replacementPassword = 'atomic reset replacement password';
    expect(
      (
        await authRequest('/v1/auth/sign-up/email', {
          name: 'Atomic Reset',
          email,
          password: initialPassword,
          callbackURL: '/login',
        })
      ).status,
    ).toBe(200);
    const verification = mail
      .readForTesting(email)
      .find((message) => message.purpose === 'verification');
    await runtime.auth.handler(
      new Request(verification?.url ?? 'http://invalid', {
        headers: { origin: 'http://pertexo.test' },
        redirect: 'manual',
      }),
    );
    const signedIn = await authRequest('/v1/auth/sign-in/email', {
      email,
      password: initialPassword,
      callbackURL: '/workspaces',
    });
    const oldCookie = cookieValue(signedIn.headers.getSetCookie()) ?? '';
    expect(oldCookie).not.toBe('');
    expect(
      (
        await authRequest('/v1/auth/request-password-reset', {
          email,
          redirectTo: '/reset-password',
        })
      ).status,
    ).toBe(200);
    const resetMail = mail
      .readForTesting(email)
      .find((message) => message.purpose === 'password_reset');
    expect(resetMail).toBeDefined();
    const token =
      new URL(resetMail?.url ?? 'http://invalid').pathname.split('/').at(-1) ??
      '';
    expect(token.length).toBeGreaterThan(10);

    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(`create function app.test_reject_reset_revocation()
        returns trigger language plpgsql as $$
        begin raise exception 'test reset revocation failure'; end;
        $$`);
      await owner.query(`create trigger test_reject_reset_revocation
        before delete on app.auth_sessions for each row
        execute function app.test_reject_reset_revocation()`);
      const failed = await authRequest(
        '/v1/auth/account-security/password/reset',
        {
          token,
          newPassword: replacementPassword,
        },
      );
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await runtime.sessions.authenticate(oldCookie)).toBeDefined();
    } finally {
      await owner.query(
        'drop trigger if exists test_reject_reset_revocation on app.auth_sessions',
      );
      await owner.query(
        'drop function if exists app.test_reject_reset_revocation()',
      );
      await owner.end();
    }

    const competing = await Promise.all([
      authRequest('/v1/auth/account-security/password/reset', {
        token,
        newPassword: replacementPassword,
      }),
      authRequest('/v1/auth/account-security/password/reset', {
        token,
        newPassword: replacementPassword,
      }),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);
    expect(
      (
        await authRequest('/v1/auth/reset-password', {
          token,
          newPassword: initialPassword,
        })
      ).status,
    ).toBe(404);
    expect(await runtime.sessions.authenticate(oldCookie)).toBeUndefined();
    expect(
      (
        await authRequest('/v1/auth/sign-in/email', {
          email,
          password: initialPassword,
          callbackURL: '/workspaces',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await authRequest('/v1/auth/sign-in/email', {
          email,
          password: replacementPassword,
          callbackURL: '/workspaces',
        })
      ).status,
    ).toBe(200);
  });

  it('does not deliver reset mail or create a password method for social-only users', async () => {
    const userId = randomUUID();
    const email = 'social-reset@example.test';
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(
        `insert into app.users(id,email,display_name,email_verified)
         values($1,$2,'Social Reset',true)`,
        [userId, email],
      );
      await owner.query(
        `insert into app.auth_accounts(id,account_id,provider_id,user_id)
         values($1,'social-reset-subject','google',$2)`,
        [randomUUID(), userId],
      );
      const response = await authRequest('/v1/auth/request-password-reset', {
        email,
        redirectTo: '/reset-password',
      });
      expect(response.status).toBe(200);
      expect(
        mail
          .readForTesting(email)
          .filter((message) => message.purpose === 'password_reset'),
      ).toHaveLength(0);
      const methods = await owner.query<{ provider_id: string }>(
        'select provider_id from app.auth_accounts where user_id=$1',
        [userId],
      );
      expect(methods.rows).toEqual([{ provider_id: 'google' }]);
    } finally {
      await owner.end();
    }
  });

  it('revokes sessions atomically with a canonical email update under the API role', async () => {
    const userId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await owner.query(
        `insert into app.users(id,email,display_name,email_verified)
         values($1,'before-email@example.test','Email Change',true)`,
        [userId],
      );
      await owner.query(
        `insert into app.auth_sessions(id,expires_at,token,user_id)
         values($1,clock_timestamp()+interval '1 hour',$2,$3)`,
        [randomUUID(), randomUUID(), userId],
      );
      await api.query(
        `update app.users set email='after-email@example.test' where id=$1`,
        [userId],
      );
      const committed = await owner.query<{
        email: string;
        session_count: number;
      }>(
        `select users.email,
                (select count(*)::integer from app.auth_sessions where user_id=users.id) session_count
           from app.users users where users.id=$1`,
        [userId],
      );
      expect(committed.rows).toEqual([
        { email: 'after-email@example.test', session_count: 0 },
      ]);

      await owner.query(
        `insert into app.auth_sessions(id,expires_at,token,user_id)
         values($1,clock_timestamp()+interval '1 hour',$2,$3)`,
        [randomUUID(), randomUUID(), userId],
      );
      await owner.query(`create function app.test_fail_email_revocation()
        returns trigger language plpgsql as $$
        begin raise exception 'test email revocation failure'; end;
        $$`);
      await owner.query(`create trigger test_fail_email_revocation
        before delete on app.auth_sessions for each row
        execute function app.test_fail_email_revocation()`);
      try {
        await expect(
          api.query(
            `update app.users set email='should-rollback@example.test' where id=$1`,
            [userId],
          ),
        ).rejects.toThrow();
      } finally {
        await owner.query(
          'drop trigger if exists test_fail_email_revocation on app.auth_sessions',
        );
        await owner.query(
          'drop function if exists app.test_fail_email_revocation()',
        );
      }
      const rolledBack = await owner.query<{
        email: string;
        session_count: number;
      }>(
        `select users.email,
                (select count(*)::integer from app.auth_sessions where user_id=users.id) session_count
           from app.users users where users.id=$1`,
        [userId],
      );
      expect(rolledBack.rows).toEqual([
        { email: 'after-email@example.test', session_count: 1 },
      ]);
    } finally {
      await Promise.all([api.end(), owner.end()]);
    }
  });

  it('revokes the same browser authority when an owned workspace becomes unavailable', async () => {
    const email = 'workspace-owner@example.test';
    const signUp = await authRequest('/v1/auth/sign-up/email', {
      name: 'Workspace Owner',
      email,
      password: 'workspace owner secure password',
      callbackURL: '/login',
    });
    expect(signUp.status).toBe(200);
    const verification = mail
      .readForTesting(email)
      .find((message) => message.purpose === 'verification');
    expect(verification).toBeDefined();
    await followMailLink(verification?.url ?? 'http://invalid', '');
    const signIn = await authRequest('/v1/auth/sign-in/email', {
      email,
      password: 'workspace owner secure password',
      callbackURL: '/workspaces',
    });
    expect(signIn.status).toBe(200);
    const cookie = cookieValue(signIn.headers.getSetCookie());
    const authenticated = await runtime.sessions.authenticate(cookie ?? '');
    expect(authenticated).toBeDefined();

    const workspaceId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(
        `insert into app.workspaces(id,name,slug,created_by)
         values($1,'Session revocation workspace',$2,$3)`,
        [
          workspaceId,
          `session-revocation-${workspaceId}`,
          authenticated?.userId,
        ],
      );
      await owner.query(
        `insert into app.workspace_memberships(workspace_id,user_id,role,status)
         values($1,$2,'owner','active')`,
        [workspaceId, authenticated?.userId],
      );
      await expect(
        owner.query<{ status: string }>(
          'select status from app.workspaces where id=$1',
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [{ status: 'active' }] });
      await owner.query(
        `update app.workspaces set status='suspended',updated_at=clock_timestamp()
          where id=$1`,
        [workspaceId],
      );
      const sessions = await owner.query<{
        count: number;
        membership_status: string;
        workspace_status: string;
      }>(
        `select workspace.status workspace_status,
                membership.status membership_status,
                count(session.id)::integer count
           from app.workspaces workspace
           join app.workspace_memberships membership
             on membership.workspace_id=workspace.id
           left join app.auth_sessions session
             on session.user_id=membership.user_id
          where workspace.id=$1 and membership.user_id=$2
          group by workspace.status,membership.status`,
        [workspaceId, authenticated?.userId],
      );
      expect(sessions.rows).toEqual([
        {
          count: 0,
          membership_status: 'active',
          workspace_status: 'suspended',
        },
      ]);
    } finally {
      await owner.end();
    }
    expect(await runtime.sessions.authenticate(cookie ?? '')).toBeUndefined();
  });

  it('keeps authentication tables outside the worker runtime role', async () => {
    const worker = new Pool({ connectionString: workerUrl, max: 1 });
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await expect(
        worker.query('select id from app.auth_sessions'),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        worker.query('select id from app.auth_email_proofs'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query('select token_digest from app.auth_email_proofs'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query('delete from app.identity_security_audit_facts'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await Promise.all([worker.end(), api.end()]);
    }
  });
});

function authRequest(path: string, body: object): Promise<Response> {
  return runtime.auth.handler(
    new Request(`http://pertexo.test${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'http://pertexo.test',
      },
      body: JSON.stringify(body),
    }),
  );
}

function cookieValue(cookies: readonly string[]): string | undefined {
  const prefix = 'pertexo_session=';
  const cookie = cookies.find((value) => value.startsWith(prefix));
  return cookie?.slice(prefix.length).split(';', 1)[0];
}

function cookieName(cookie: string): string {
  return cookie.split('=', 1)[0] ?? '';
}

function authenticatedRequest(
  path: string,
  method: 'GET' | 'POST',
  sessionCookie: string,
  csrf: string | undefined,
  body?: object,
): Promise<Response> {
  const cookie = [
    `pertexo_session=${sessionCookie}`,
    ...(csrf === undefined ? [] : [`pertexo_csrf=${encodeURIComponent(csrf)}`]),
  ].join('; ');
  return runtime.auth.handler(
    new Request(`http://pertexo.test${path}`, {
      method,
      headers: {
        accept: 'application/json',
        cookie,
        origin: 'http://pertexo.test',
        ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function followMailLink(url: string, sessionCookie: string): Promise<Response> {
  return runtime.auth.handler(
    new Request(url, {
      headers: {
        cookie: `pertexo_session=${sessionCookie}`,
        origin: 'http://pertexo.test',
      },
      redirect: 'manual',
    }),
  );
}
