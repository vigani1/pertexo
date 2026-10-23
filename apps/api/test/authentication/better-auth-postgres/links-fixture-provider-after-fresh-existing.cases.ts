import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { registerBetterAuthHandler } from '../../../src/authentication/better-auth/fastify.js';

import * as browserSessionBoundary from '../../../src/authentication/better-auth/trusted-sessions.js';
import {
  adminUrl,
  databaseName,
  databaseUrl,
  mailedMessages,
  runtime,
  cookieValue,
  callbackOrderings,
  assertSingleProviderLink,
} from './fixture.js';

export function registerLinksFixtureProviderAfterFreshExisting(): void {
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
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect((await signUp()).statusCode).toBe(200);
    } finally {
      await admin.end();
      await application.close();
    }
  });
}
