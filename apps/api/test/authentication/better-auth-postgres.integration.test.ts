import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  prepareBetterAuthPostgresIntegrationTestTs,
  closeBetterAuthPostgresIntegrationTestTs,
  adminUrl,
  databaseName,
  databaseUrl,
  mailedMessages,
  runtime,
  cookieValue,
  callbackOrderings,
  assertSingleProviderLink,
  apiUrl,
  authRequest,
  followMailLink,
  cookieName,
  authenticatedRequest,
  signInVerifiedUser,
  sha256Hex,
  createInvitationProofSession,
} from './better-auth-postgres/fixture.js';
import { randomUUID, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { registerBetterAuthHandler } from '../../src/authentication/better-auth/fastify.js';
import * as browserSessionBoundary from '../../src/authentication/better-auth/trusted-sessions.js';
import {
  authenticationMailAssociatedData,
  createSystemMailEnqueueStore,
} from '@pertexo/secrets/server';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import { DurableAuthenticationMail } from '../../src/authentication/mail/delivery.js';
import { createBetterAuthRuntime } from '../../src/authentication/better-auth/runtime.js';
import { createIdentityWorkspaceStore } from '@pertexo/core/tenant-access';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { BetterAuthSessionService } from '../../src/authentication/better-auth/session-service.js';

type VerifiedSession = Awaited<ReturnType<typeof createVerifiedSession>>;

type SessionControls = Awaited<ReturnType<typeof verifySessionControls>>;

type PasswordReplacement = Awaited<
  ReturnType<typeof verifyPasswordReplacement>
>;

type MethodUnlink = Awaited<ReturnType<typeof verifyMethodUnlinkAudit>>;

type EmailReplacement = Awaited<ReturnType<typeof verifyEmailReplacement>>;

async function createVerifiedSession() {
  const signUp = await authRequest('/v1/auth/sign-up/email', {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    password: 'correct horse battery staple',
    callbackURL: '/login',
  });
  expect(signUp.status).toBe(200);
  expect(signUp.headers.getSetCookie()).toHaveLength(0);

  const verification = mailedMessages('ada@example.test').find(
    (message) => message.purpose === 'verification',
  );
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
  const authenticated = await runtime.sessions.authenticate(signedCookie ?? '');
  expect(authenticated?.userId).toMatch(/^[0-9a-f-]{36}$/u);

  return { signedCookie, authenticated };
}

async function verifySessionControls(evidence: VerifiedSession) {
  const { signedCookie, authenticated } = evidence;
  const secondSession = await runtime.sessions.issue(
    authenticated?.userId ?? '',
  );
  const secondCookie = cookieValue(secondSession.setCookies);
  expect(secondCookie).toBeDefined();
  const csrf = 'test-csrf-token-with-more-than-thirty-two-characters';
  const list = await authenticatedRequest({
    path: '/v1/auth/account-security/sessions',
    method: 'GET',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
  });
  expect(list.status).toBe(200);
  const listed = (await list.json()) as {
    items: { id: string; current: boolean; token?: string }[];
  };
  expect(listed.items).toHaveLength(2);
  expect(listed.items.every((session) => session.token === undefined)).toBe(
    true,
  );
  expect(listed.items.some((session) => session.current)).toBe(true);

  const missingCsrf = await authenticatedRequest({
    path: '/v1/auth/account-security/sessions/revoke',
    method: 'POST',
    sessionCookie: signedCookie ?? '',
    csrf: undefined,
    body: { sessionId: secondSession.sessionId },
  });
  expect(missingCsrf.status).toBe(403);
  expect(await runtime.sessions.authenticate(secondCookie ?? '')).toBeDefined();

  const revoke = await authenticatedRequest({
    path: '/v1/auth/account-security/sessions/revoke',
    method: 'POST',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
    body: { sessionId: secondSession.sessionId },
  });
  expect(revoke.status).toBe(200);
  expect(await revoke.json()).toEqual({ revoked: true });
  expect(
    await runtime.sessions.authenticate(secondCookie ?? ''),
  ).toBeUndefined();

  const methods = await authenticatedRequest({
    path: '/v1/auth/account-security',
    method: 'GET',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
  });
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

  const blockedLink = await authenticatedRequest({
    path: '/v1/auth/link-social',
    method: 'POST',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
    body: {
      provider: 'google',
      callbackURL: '/account/security',
      disableRedirect: true,
    },
  });
  expect(blockedLink.status).toBe(403);
  const afterBlockedLink = await authenticatedRequest({
    path: '/v1/auth/account-security',
    method: 'GET',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
  });
  expect(
    ((await afterBlockedLink.json()) as { methods: unknown[] }).methods,
  ).toHaveLength(1);

  return { csrf, passwordMethodId };
}

async function verifyPasswordReplacement(
  evidence: VerifiedSession & SessionControls,
) {
  const { signedCookie, csrf, passwordMethodId } = evidence;
  const passwordChange = await authenticatedRequest({
    path: '/v1/auth/account-security/password/change',
    method: 'POST',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
    body: {
      currentPassword: 'correct horse battery staple',
      newPassword: 'another correct horse battery staple',
    },
  });
  expect(passwordChange.status).toBe(200);
  const replacementCookie = cookieValue(passwordChange.headers.getSetCookie());
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

  const lastMethod = await authenticatedRequest({
    path: '/v1/auth/account-security/methods/unlink',
    method: 'POST',
    sessionCookie: replacementCookie ?? '',
    csrf: csrf,
    body: { methodId: passwordMethodId },
  });
  expect(lastMethod.status).toBe(400);

  return { replacementCookie };
}

async function verifyMethodUnlinkAudit(
  evidence: VerifiedSession & PasswordReplacement & SessionControls,
) {
  const { authenticated, replacementCookie, csrf } = evidence;
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
  const unlink = await authenticatedRequest({
    path: '/v1/auth/account-security/methods/unlink',
    method: 'POST',
    sessionCookie: replacementCookie ?? '',
    csrf: csrf,
    body: { methodId: socialMethodId },
  });
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
  expect(await runtime.sessions.authenticate(unlinkCookie ?? '')).toBeDefined();

  return { unlinkCookie };
}

async function verifyEmailReplacement(
  evidence: MethodUnlink & SessionControls,
) {
  const { unlinkCookie, csrf } = evidence;
  const changeEmail = await authenticatedRequest({
    path: '/v1/auth/change-email',
    method: 'POST',
    sessionCookie: unlinkCookie ?? '',
    csrf: csrf,
    body: {
      newEmail: 'ada.new@example.test',
      callbackURL: '/login?emailChanged=true',
    },
  });
  expect(changeEmail.status).toBe(200);
  const oldAddressConfirmation = mailedMessages('ada@example.test').find(
    (message) => message.purpose === 'email_change_confirmation',
  );
  expect(oldAddressConfirmation).toBeDefined();
  const confirmOld = await followMailLink(
    oldAddressConfirmation?.url ?? 'http://invalid',
    unlinkCookie ?? '',
  );
  expect([200, 302]).toContain(confirmOld.status);
  expect(confirmOld.headers.get('location')).toContain(
    'emailChangePending=true',
  );
  const newAddressVerification = mailedMessages('ada.new@example.test').find(
    (message) => message.purpose === 'verification',
  );
  expect(newAddressVerification).toBeDefined();
  const replayOld = await followMailLink(
    oldAddressConfirmation?.url ?? 'http://invalid',
    unlinkCookie ?? '',
  );
  expect(replayOld.headers.get('location')).toContain(
    'error=verification_invalid',
  );
  expect(
    mailedMessages('ada.new@example.test').filter(
      (message) => message.purpose === 'verification',
    ),
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

  return { newEmailCookie };
}

async function verifySuspendedSession(
  evidence: VerifiedSession & PasswordReplacement & EmailReplacement,
) {
  const { signedCookie, replacementCookie, newEmailCookie } = evidence;
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
}

beforeAll(prepareBetterAuthPostgresIntegrationTestTs, 60_000);
afterAll(closeBetterAuthPostgresIntegrationTestTs);
describe('Better Auth on PostgreSQL', () => {
  it.each(callbackOrderings)(
    'links a fixture provider only after a fresh existing-method proof and rotates the session once: %s',
    (ordering) => assertSingleProviderLink(ordering),
  );

  it.each(['early-return', 'early-rejection'] as const)(
    'cleans up account-link callback gates and runtime after %s before authentication',
    async (failure) => {
      const originalAuthenticate =
        browserSessionBoundary.authenticateBrowserRequest;
      const operation = assertSingleProviderLink(
        'loser authentication after commit',
        failure,
      );
      if (failure === 'early-return') {
        await expect(operation).resolves.toBeUndefined();
      } else {
        await expect(operation).rejects.toThrow(
          'Fixture callback rejected before authentication',
        );
      }
      expect(browserSessionBoundary.authenticateBrowserRequest).toBe(
        originalAuthenticate,
      );
    },
  );

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
      const verification = mailedMessages(email).find(
        (message) => message.purpose === 'verification',
      );
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

  it('keeps serving after PostgreSQL ends an idle connection', async () => {
    const application = Fastify();
    registerBetterAuthHandler(application, {
      handler: runtime.auth.handler,
      rateLimitConsumer: {
        consume: () => Promise.resolve({ allowed: true as const }),
      },
      publicOrigin: 'http://pertexo.test',
      sessionCookie: { secure: false, sameSite: 'lax', maxAgeSeconds: 3_600 },
    });
    const signUp = () =>
      application.inject({
        method: 'POST',
        url: '/v1/auth/sign-up/email',
        headers: { origin: 'http://pertexo.test' },
        payload: {
          name: 'Restart Survivor',
          email: `restart-${randomUUID()}@example.test`,
          password: 'correct horse battery staple',
        },
      });
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      expect((await signUp()).statusCode).toBe(200);
      // What a PostgreSQL restart or failover does to the pool's idle
      // connections. An unhandled pool error would end the whole process.
      const ended = await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname=$1 and application_name='pertexo-api-authentication'`,
        [databaseName],
      );
      expect(ended.rowCount).toBeGreaterThan(0);
      await expect
        .poll(async () => (await signUp()).statusCode, {
          timeout: 250,
          interval: 10,
        })
        .toBe(200);
    } finally {
      await admin.end();
      await application.close();
    }
  });

  it('commits encrypted authentication mail before acknowledging enqueue', async () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key },
    });
    const store = createSystemMailEnqueueStore({
      connectionString: apiUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 1,
      ownerRole: 'pertexo_owner',
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
           from app.system_mail_deliveries
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
    const store = createSystemMailEnqueueStore({
      connectionString: apiUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 1,
      ownerRole: 'pertexo_owner',
    });
    const durable = createBetterAuthRuntime({
      signUpMode: 'open',
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
            from app.system_mail_deliveries mail
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
             from app.system_mail_deliveries
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
        before insert on app.system_mail_deliveries for each row
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
          'drop trigger if exists test_reject_proof_mail on app.system_mail_deliveries',
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
    const link = mailedMessages(concurrentEmail).find(
      (message) => message.purpose === 'verification',
    )?.url;
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
      const expiredLink = mailedMessages(expiredEmail).find(
        (message) => message.purpose === 'verification',
      )?.url;
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
    const link = mailedMessages(email).find(
      (message) => message.purpose === 'verification',
    )?.url;
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
    const session = await createVerifiedSession();
    const controls = await verifySessionControls(session);
    const password = await verifyPasswordReplacement({
      ...session,
      ...controls,
    });
    const method = await verifyMethodUnlinkAudit({
      ...session,
      ...controls,
      ...password,
    });
    const email = await verifyEmailReplacement({ ...controls, ...method });
    await verifySuspendedSession({ ...session, ...password, ...email });
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
    const verification = mailedMessages(email).find(
      (message) => message.purpose === 'verification',
    );
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
      const rejected = await authenticatedRequest({
        path: '/v1/auth/account-security/password/change',
        method: 'POST',
        sessionCookie: signedCookie,
        csrf: 'test-csrf-token-with-more-than-thirty-two-characters',
        body: { currentPassword: originalPassword, newPassword },
      });
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
      authenticatedRequest({
        path: '/v1/auth/account-security/password/setup',
        method: 'POST',
        sessionCookie: cookie,
        csrf: csrf,
        body: {
          newPassword: 'social setup secure password one',
        },
      }),
      authenticatedRequest({
        path: '/v1/auth/account-security/password/setup',
        method: 'POST',
        sessionCookie: cookie,
        csrf: csrf,
        body: {
          newPassword: 'social setup secure password two',
        },
      }),
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
    const verification = mailedMessages(email).find(
      (message) => message.purpose === 'verification',
    );
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
    const resetMail = mailedMessages(email).find(
      (message) => message.purpose === 'password_reset',
    );
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
        mailedMessages(email).filter(
          (message) => message.purpose === 'password_reset',
        ),
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

  it('lands an accepted invitation on one delivered Better Auth replacement session', async () => {
    const email = 'invitation-recipient@example.test';
    const { cookie, authenticated } = await signInVerifiedUser(
      email,
      'Invitation Recipient',
    );
    const recipientId = authenticated?.userId ?? '';
    const identity = createIdentityWorkspaceStore(
      parseDatabaseConfig({
        connectionString: apiUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        max: 2,
        ownerRole: 'pertexo_owner',
      }),
    );
    try {
      const owner = await identity.createUser({
        email: 'invitation-owner@example.test',
        displayName: 'Invitation Owner',
      });
      const workspace = await identity.createWorkspaceWithOwner({
        name: 'Better Auth invitation',
        slug: `better-auth-invite-${randomUUID().slice(0, 8)}`,
        ownerUserId: owner.id,
      });
      const tokenDigest = sha256Hex(randomUUID());
      const created = await identity.createWorkspaceInvitation({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        email,
        role: 'viewer',
        idempotencyKey: randomUUID(),
        tokenDigest,
        sealedToken: {
          ciphertext: 'sealed-token',
          nonce: 'nonce',
          tag: 'tag',
          keyVersion: 'test-v1',
        },
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
      const intentId = randomUUID();
      const bindingDigest = sha256Hex(randomUUID());
      await identity.resolveInvitationAcceptance({
        workspaceId: workspace.id,
        invitationId: created.invitation.id,
        tokenDigest,
        intentId,
        bindingDigest,
        csrfDigest: sha256Hex(randomUUID()),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      await identity.recordInvitationAcceptanceProof({
        workspaceId: workspace.id,
        intentId,
        bindingDigest,
        userId: recipientId,
        sessionId: await createInvitationProofSession(recipientId),
        verifiedEmail: email,
        verifiedAt: new Date(),
      });
      const sessions = new BetterAuthSessionService(runtime, {
        secure: false,
        sameSite: 'lax',
        ttlSeconds: 3_600,
      });
      const replacementToken = randomBytes(32).toString('base64url');
      const command = {
        workspaceId: workspace.id,
        intentId,
        invitationRevision: 1,
        actorUserId: recipientId,
        idempotencyKey: randomUUID(),
        replacementSession: {
          id: randomUUID(),
          token: replacementToken,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      };

      await expect(
        identity.completeInvitationAcceptance(command),
      ).resolves.toMatchObject({
        membershipCreated: true,
        replacementSessionCreated: true,
      });
      await expect(
        runtime.sessions.authenticate(cookie ?? ''),
      ).resolves.toBeUndefined();
      const delivered: string[] = [];
      await sessions.deliver(replacementToken, {
        writeSessionCookieHeaders: (setCookies) => {
          delivered.push(...setCookies);
        },
      });
      const replacementCookie = cookieValue(delivered) ?? '';
      await expect(
        sessions.authenticate(decodeURIComponent(replacementCookie)),
      ).resolves.toMatchObject({ userId: recipientId });
      await expect(
        identity.completeInvitationAcceptance(command),
      ).resolves.toMatchObject({
        replayed: true,
        replacementSessionCreated: false,
      });
      await expect(
        sessions.authenticate(decodeURIComponent(replacementCookie)),
      ).resolves.toMatchObject({ userId: recipientId });
      const admin = new Pool({
        connectionString: databaseUrl(adminUrl),
        max: 1,
      });
      try {
        const sessionRows = await admin.query<{ count: number }>(
          'select count(*)::int count from app.auth_sessions where user_id=$1',
          [recipientId],
        );
        expect(sessionRows.rows).toEqual([{ count: 1 }]);
      } finally {
        await admin.end();
      }
    } finally {
      await identity.close();
    }
  });

  it('revokes the same browser authority when an owned workspace becomes unavailable', async () => {
    const { cookie, authenticated } = await signInVerifiedUser(
      'workspace-owner@example.test',
      'Workspace Owner',
    );

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

  it('keeps identity audit facts out of reach of app deletes', async () => {
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await expect(
        api.query('delete from app.identity_security_audit_facts'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
  });
});
