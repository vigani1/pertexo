import { randomUUID } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { apiProblemSchema } from '@pertexo/contracts';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerBetterAuthHandler } from '../../../src/authentication/better-auth/fastify.js';
import { allowingRateLimit, applications } from './fixture.js';

export function registerKeepsNativeBrowserResponsesTokenFree(): void {
  it('keeps native browser responses token-free and blocks unused token endpoints', async () => {
    const application = Fastify();
    applications.push(application);
    const handler = vi.fn((request: Request) =>
      Promise.resolve(
        Response.json({
          redirect: false,
          token: 'raw-session-token',
          user: { id: 'user-id', accessToken: 'provider-token' },
          url: new URL(request.url).origin,
        }),
      ),
    );
    registerBetterAuthHandler(application, {
      handler,
      rateLimitConsumer: allowingRateLimit,
      publicOrigin: 'https://pertexo.test',
      sessionCookie: {
        secure: true,
        sameSite: 'lax',
        maxAgeSeconds: 3_600,
      },
    });

    const signedIn = await application.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/email',
      headers: { origin: 'https://pertexo.test' },
      payload: { email: 'ada@example.test', password: 'example-password' },
    });
    expect(signedIn.json()).toEqual({
      redirect: false,
      user: { id: 'user-id' },
      url: 'https://pertexo.test',
    });

    for (const path of [
      '/v1/auth/get-session',
      '/v1/auth/get-session/',
      '/v1/auth/get-session/?disableCookieCache=true',
      '/v1/auth/get-access-token',
      '/v1/auth/refresh-token',
      '/v1/auth/list-accounts',
      '/v1/auth/account-info',
      '/v1/auth/update-session',
      '/v1/auth/reset-password',
    ]) {
      const blocked = await application.inject({ method: 'GET', url: path });
      expect(blocked.statusCode, path).toBe(404);
      expect(blocked.json(), path).toMatchObject({
        code: 'resource.not_found',
      });
    }
    expect(handler).toHaveBeenCalledOnce();
  });

  it('translates native authentication errors into safe, parseable problem details', async () => {
    const application = Fastify();
    applications.push(application);
    registerBetterAuthHandler(application, {
      publicOrigin: 'https://pertexo.test',
      rateLimitConsumer: allowingRateLimit,
      sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3_600 },
      handler: (request) => {
        const path = new URL(request.url).pathname;
        const native = path.endsWith('/sign-in/email')
          ? { status: 403, code: 'EMAIL_NOT_VERIFIED' }
          : { status: 400, code: 'INVALID_TOKEN' };
        return Promise.resolve(
          Response.json(
            {
              code: native.code,
              message: 'Internal Better Auth details are not public',
            },
            { status: native.status },
          ),
        );
      },
    });
    for (const [path, expectedCode] of [
      ['/v1/auth/sign-in/email', 'auth.email_not_verified'],
      ['/v1/auth/account-security/password/reset', 'auth.reset_link_invalid'],
    ] as const) {
      const response = await application.inject({
        method: 'POST',
        url: path,
        headers: { origin: 'https://pertexo.test' },
        payload: {},
      });
      const problem = apiProblemSchema.parse(response.json());
      expect(problem.code).toBe(expectedCode);
      expect(problem.requestId).toBe(response.headers['x-request-id']);
      expect(JSON.stringify(problem)).not.toContain(
        'Internal Better Auth details',
      );
    }
  });

  it.each(['verify-totp', 'verify-backup-code'])(
    'identifies account lockout on %s without exposing native error details',
    async (path) => {
      const application = Fastify();
      applications.push(application);
      registerBetterAuthHandler(application, {
        publicOrigin: 'https://pertexo.test',
        rateLimitConsumer: allowingRateLimit,
        sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3600 },
        handler: () =>
          Promise.resolve(
            Response.json(
              {
                code: 'ACCOUNT_TEMPORARILY_LOCKED',
                message: 'private native details',
              },
              { status: 429 },
            ),
          ),
      });
      const reply = await application.inject({
        method: 'POST',
        url: `/v1/auth/two-factor/${path}`,
        headers: { origin: 'https://pertexo.test' },
        payload: { code: '123456' },
      });
      expect(reply.statusCode).toBe(429);
      expect(apiProblemSchema.parse(reply.json())).toMatchObject({
        code: 'auth.two_factor_locked',
        title: 'Two-factor sign-in temporarily locked',
      });
      expect(reply.payload).not.toContain('private native details');
      expect(reply.payload).not.toContain('123456');
    },
  );

  it('exposes the Better Auth password-reset request contract', async () => {
    const auth = betterAuth({
      appName: 'Pertexo',
      baseURL: 'https://pertexo.test',
      basePath: '/v1/auth',
      secret: 'password-reset-proof-secret-at-least-32-characters',
      database: memoryAdapter({
        user: [],
        account: [],
        session: [],
        verification: [],
      }),
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 12,
        sendResetPassword: () => Promise.resolve(),
      },
      advanced: { database: { generateId: () => randomUUID() } },
      telemetry: { enabled: false },
    });
    const application = Fastify();
    applications.push(application);
    registerBetterAuthHandler(application, {
      handler: auth.handler,
      rateLimitConsumer: allowingRateLimit,
      publicOrigin: 'https://pertexo.test',
      sessionCookie: {
        secure: true,
        sameSite: 'lax',
        maxAgeSeconds: 3_600,
      },
    });

    const response = await application.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      headers: { origin: 'https://pertexo.test' },
      payload: {
        email: 'ada@example.test',
        redirectTo: '/reset-password',
      },
    });

    expect(response.statusCode).toBe(200);
  });
}
