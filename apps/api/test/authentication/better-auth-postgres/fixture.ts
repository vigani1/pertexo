import { captureLocalAuthenticationMail } from '../../support/better-auth/mail-capture.js';
import { createHash, randomUUID } from 'node:crypto';

import { migrateDatabase } from '@pertexo/database/testing';

import { Pool } from 'pg';
import { expect, vi } from 'vitest';
import {
  createBetterAuthRuntime,
  type BetterAuthRuntime,
} from '../../../src/authentication/better-auth/runtime.js';
import type { SocialProviderGateway } from '../../../src/authentication/providers/contract.js';

import * as browserSessionBoundary from '../../../src/authentication/better-auth/trusted-sessions.js';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export const databaseName = `pertexo_test_auth_${randomUUID().replaceAll('-', '')}`;

export function databaseUrl(base: string): string {
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

export const apiUrl = databaseUrl(apiBaseUrl);

export const { mail, mailedMessages } = captureLocalAuthenticationMail();

export let runtime: BetterAuthRuntime;

/** Signs up, verifies and signs in a password user through Better Auth. */
export async function signInVerifiedUser(email: string, name: string) {
  const password = `${name} secure password`;
  const signUp = await authRequest('/v1/auth/sign-up/email', {
    name,
    email,
    password,
    callbackURL: '/login',
  });
  expect(signUp.status).toBe(200);
  const verification = mailedMessages(email).find(
    (message) => message.purpose === 'verification',
  );
  expect(verification).toBeDefined();
  await followMailLink(verification?.url ?? 'http://invalid', '');
  const signIn = await authRequest('/v1/auth/sign-in/email', {
    email,
    password,
    callbackURL: '/workspaces',
  });
  expect(signIn.status).toBe(200);
  const cookie = cookieValue(signIn.headers.getSetCookie());
  const authenticated = await runtime.sessions.authenticate(cookie ?? '');
  expect(authenticated).toBeDefined();
  return { cookie, authenticated };
}

export function authRequest(path: string, body: object): Promise<Response> {
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

export function cookieValue(cookies: readonly string[]): string | undefined {
  const prefix = 'pertexo_session=';
  const cookie = cookies.find((value) => value.startsWith(prefix));
  return cookie?.slice(prefix.length).split(';', 1)[0];
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function cookieName(cookie: string): string {
  return cookie.split('=', 1)[0] ?? '';
}

export function authenticatedRequest(
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

export function followMailLink(
  url: string,
  sessionCookie: string,
): Promise<Response> {
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

export async function createInvitationProofSession(
  userId: string,
): Promise<string> {
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  try {
    const existing = (
      await pool.query<{ id: string }>(
        'select id from app.auth_sessions where user_id=$1 and expires_at>clock_timestamp() order by created_at desc,id limit 1',
        [userId],
      )
    ).rows[0];
    if (existing !== undefined) return existing.id;
    const id = randomUUID();
    await pool.query(
      "insert into app.auth_sessions(id,user_id,token,expires_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')",
      [id, userId, randomUUID()],
    );
    return id;
  } finally {
    await pool.end();
  }
}

export const callbackOrderings = [
  'uncontrolled callbacks',
  'loser authentication after commit',
  'both provider proofs before commit',
] as const;

export async function assertSingleProviderLink(
  ordering: (typeof callbackOrderings)[number],
  firstCallbackFailure?: 'early-return' | 'early-rejection',
): Promise<void> {
  const email = `linked-${randomUUID()}@example.test`;
  const password = 'correct horse battery staple';
  const signup = await authRequest('/v1/auth/sign-up/email', {
    name: 'Linking Test',
    email,
    password,
  });
  expect(signup.status).toBe(200);
  const verification = mailedMessages(email).find(
    (item) => item.purpose === 'verification',
  );
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
  const bothProviderProofs = Promise.withResolvers<undefined>();
  let providerProofs = 0;
  let gateProviderProofs = false;
  const gateway: SocialProviderGateway = {
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
      const identity = {
        accountId: `${input.provider}-subject-${email}`,
        email,
        emailVerified: true,
      };
      if (gateProviderProofs) {
        providerProofs += 1;
        if (providerProofs === 2) bothProviderProofs.resolve(undefined);
        return bothProviderProofs.promise.then(() => identity);
      }
      return Promise.resolve(identity);
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
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
      {
        provider: 'google',
        existingMethod: { kind: 'password', password },
      },
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

    const loserEnteredAuthentication = Promise.withResolvers<undefined>();
    const winnerCommitted = Promise.withResolvers<undefined>();
    const originalAuthenticate =
      browserSessionBoundary.authenticateBrowserRequest;
    let authenticationCalls = 0;
    const authenticationProbe =
      ordering === 'loser authentication after commit'
        ? vi
            .spyOn(browserSessionBoundary, 'authenticateBrowserRequest')
            .mockImplementation(async (...args) => {
              authenticationCalls += 1;
              if (authenticationCalls === 1) {
                await loserEnteredAuthentication.promise;
              } else if (authenticationCalls === 2) {
                loserEnteredAuthentication.resolve(undefined);
                await winnerCommitted.promise;
              }
              return originalAuthenticate(...args);
            })
        : undefined;
    gateProviderProofs = ordering === 'both provider proofs before commit';
    const pendingCallbacks: Promise<Response>[] = [];
    let first: Response;
    let second: Response;
    try {
      const firstCallback =
        firstCallbackFailure === 'early-return'
          ? Promise.resolve(new Response(null, { status: 401 }))
          : firstCallbackFailure === 'early-rejection'
            ? Promise.reject(
                new Error('Fixture callback rejected before authentication'),
              )
            : linkRequest(callback, 'GET', originalCookie ?? '', binding);
      pendingCallbacks.push(
        firstCallback.finally(() => {
          loserEnteredAuthentication.resolve(undefined);
          winnerCommitted.resolve(undefined);
          bothProviderProofs.resolve(undefined);
        }),
        linkRequest(callback, 'GET', originalCookie ?? '', binding).finally(
          () => {
            loserEnteredAuthentication.resolve(undefined);
            winnerCommitted.resolve(undefined);
            bothProviderProofs.resolve(undefined);
          },
        ),
      );
      [first, second] = await Promise.all([
        required(pendingCallbacks[0]),
        required(pendingCallbacks[1]),
      ]);
    } finally {
      loserEnteredAuthentication.resolve(undefined);
      winnerCommitted.resolve(undefined);
      bothProviderProofs.resolve(undefined);
      try {
        const settled = await Promise.allSettled(pendingCallbacks);
        if (firstCallbackFailure !== undefined) {
          const survivingCallback = required(settled[1]);
          expect(survivingCallback.status).toBe('fulfilled');
          if (survivingCallback.status === 'fulfilled') {
            expect(survivingCallback.value.status).toBe(302);
            expect(survivingCallback.value.headers.get('location')).toBe(
              'http://pertexo.test/account/security?linked=true',
            );
          }
        }
      } finally {
        authenticationProbe?.mockRestore();
        gateProviderProofs = false;
      }
    }
    if (firstCallbackFailure === 'early-return') {
      expect(first.status).toBe(401);
      expect(authenticationCalls).toBe(1);
      return;
    }
    if (ordering === 'loser authentication after commit')
      expect(authenticationCalls).toBe(2);
    if (ordering === 'both provider proofs before commit')
      expect(providerProofs).toBe(2);
    const responses = [first, second];
    const acceptedLanding = 'http://pertexo.test/account/security?linked=true';
    const linkErrorLanding =
      'http://pertexo.test/account/security?linkError=true';
    const reauthenticateLanding =
      'http://pertexo.test/login?error=link_reauthenticate';
    const linked = responses.filter(
      (response) =>
        response.status === 302 &&
        response.headers.get('location') === acceptedLanding,
    );
    const rejected = responses.filter(
      (response) =>
        response.status === 302 &&
        [linkErrorLanding, reauthenticateLanding].includes(
          response.headers.get('location') ?? '',
        ) &&
        response.headers.getSetCookie().length === 0,
    );
    const validCallbackPair =
      linked.length === 1 &&
      rejected.length === 1 &&
      cookieValue(required(linked[0]).headers.getSetCookie()) !== undefined;
    let mismatchEvidence: unknown;
    if (!validCallbackPair) {
      const admin = new Pool({
        connectionString: databaseUrl(adminUrl),
        max: 1,
      });
      try {
        const state = await admin.query<{
          phase: string;
          accounts: number;
          audits: number;
          sessions: number;
        }>(
          `select attempt.phase,
                    (select count(*)::integer from app.auth_accounts account
                      where account.user_id=users.id and account.provider_id='google') accounts,
                    (select count(*)::integer from app.identity_security_audit_facts audit
                      where audit.user_id=users.id and audit.event_type='method.linked') audits,
                    (select count(*)::integer from app.auth_sessions session
                      where session.user_id=users.id) sessions
               from app.users users
               join app.auth_method_link_attempts attempt on attempt.user_id=users.id
              where users.email=$1`,
          [email],
        );
        mismatchEvidence = {
          outcomes: responses.map((response) => ({
            status: response.status,
            kind:
              response.headers.get('location') === acceptedLanding
                ? 'linked'
                : response.headers.get('location') === linkErrorLanding
                  ? 'link-error'
                  : response.headers.get('location') === reauthenticateLanding
                    ? 'reauthenticate'
                    : 'other',
            sessionCookieIssued:
              cookieValue(response.headers.getSetCookie()) !== undefined,
          })),
          durable: state.rows,
        };
      } finally {
        await admin.end();
      }
    }
    if (!validCallbackPair)
      throw new Error(
        `Expected one accepted and one safely rejected account-link callback: ${JSON.stringify(mismatchEvidence)}`,
      );
    expect(linked).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (ordering === 'loser authentication after commit') {
      expect(first.headers.get('location')).toBe(acceptedLanding);
      expect(second.headers.get('location')).toBe(reauthenticateLanding);
    }
    if (ordering === 'both provider proofs before commit')
      expect(required(rejected[0]).headers.get('location')).toBe(
        linkErrorLanding,
      );
    const accepted = required(linked[0]);
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
    expect(replay.status).toBe(302);
    expect(replay.headers.get('location')).toBe(linkErrorLanding);
    expect(replay.headers.getSetCookie()).toEqual([]);

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
}

export async function prepareBetterAuthPostgresIntegrationTestTs() {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_app`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: migrationUrl,
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
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
}

export async function closeBetterAuthPostgresIntegrationTestTs() {
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
}
