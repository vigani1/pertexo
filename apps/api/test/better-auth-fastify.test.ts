import { randomUUID } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { apiProblemSchema } from '@pertexo/contracts/schemas/errors';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerAuthenticationCapabilities,
  registerBetterAuthHandler,
} from '../src/identity-infrastructure/better-auth-fastify.js';

const allowingRateLimit = {
  consume: () => Promise.resolve({ allowed: true as const }),
};

describe('Better Auth Fastify bridge', () => {
  const applications: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(
      applications.splice(0).map((application) => application.close()),
    );
  });

  it('preserves JSON bodies, origin checks and every Set-Cookie header', async () => {
    const auth = betterAuth({
      appName: 'Pertexo',
      baseURL: 'https://pertexo.test',
      basePath: '/v1/auth',
      secret: 'fastify-proof-secret-with-at-least-32-characters',
      database: memoryAdapter({
        user: [],
        account: [],
        session: [],
        verification: [],
      }),
      emailAndPassword: { enabled: true, minPasswordLength: 12 },
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

    const rejected = await application.inject({
      method: 'POST',
      url: '/v1/auth/sign-up/email',
      headers: { origin: 'https://attacker.test' },
      payload: {
        name: 'Ada Lovelace',
        email: 'ada@example.test',
        password: 'correct horse battery staple',
      },
    });
    expect(rejected.statusCode).toBe(403);

    const accepted = await application.inject({
      method: 'POST',
      url: '/v1/auth/sign-up/email',
      headers: { origin: 'https://pertexo.test' },
      payload: {
        name: 'Ada Lovelace',
        email: 'ada@example.test',
        password: 'correct horse battery staple',
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers['set-cookie']).toBeDefined();
    const acceptedBody = accepted.json<{
      user: { id: string; email: string };
    }>();
    expect(acceptedBody.user.email).toBe('ada@example.test');
    expect(acceptedBody.user.id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('forwards multiple Set-Cookie response fields independently', async () => {
    const application = Fastify();
    applications.push(application);
    registerBetterAuthHandler(application, {
      publicOrigin: 'https://pertexo.test',
      rateLimitConsumer: allowingRateLimit,
      sessionCookie: {
        secure: true,
        sameSite: 'lax',
        maxAgeSeconds: 3_600,
      },
      handler: () => {
        const headers = new Headers();
        headers.append('set-cookie', 'first=one; Path=/; HttpOnly');
        headers.append('set-cookie', 'second=two; Path=/; SameSite=Lax');
        return Promise.resolve(new Response(null, { status: 204, headers }));
      },
    });

    const response = await application.inject({
      method: 'GET',
      url: '/v1/auth/test-cookies',
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toEqual([
      'first=one; Path=/; HttpOnly',
      'second=two; Path=/; SameSite=Lax',
    ]);
  });

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

  it('serves configured capabilities and bootstraps application CSRF with a session', async () => {
    const application = Fastify();
    applications.push(application);
    registerAuthenticationCapabilities(application, {
      password: {
        enabled: true,
        minimumLength: 12,
        verificationRequired: true,
      },
      socialProviders: ['google'],
      legacyMigrationAvailable: false,
    });
    registerBetterAuthHandler(application, {
      publicOrigin: 'https://pertexo.test',
      rateLimitConsumer: allowingRateLimit,
      sessionCookie: {
        secure: true,
        sameSite: 'lax',
        maxAgeSeconds: 3_600,
      },
      handler: () => {
        const headers = new Headers();
        headers.append(
          'set-cookie',
          'pertexo_session=signed-value; Path=/; HttpOnly; Secure; SameSite=Lax',
        );
        return Promise.resolve(Response.json({ ok: true }, { headers }));
      },
    });

    const capabilities = await application.inject({
      method: 'GET',
      url: '/v1/auth/capabilities',
    });
    expect(capabilities.json()).toEqual({
      password: {
        enabled: true,
        minimumLength: 12,
        verificationRequired: true,
      },
      socialProviders: ['google'],
      legacyMigrationAvailable: false,
    });

    const response = await application.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/email',
      headers: { origin: 'https://pertexo.test' },
      payload: { email: 'ada@example.test', password: 'example-password' },
    });
    expect(response.headers['set-cookie']).toEqual([
      'pertexo_session=signed-value; Path=/; HttpOnly; Secure; SameSite=Lax',
      expect.stringMatching(
        /^pertexo_csrf=[A-Za-z0-9_-]{43}; Path=\/; Secure; SameSite=Lax; Max-Age=3600$/u,
      ),
    ]);
  });

  it('applies distributed admission to native writes and callbacks before dispatch', async () => {
    const application = Fastify();
    applications.push(application);
    const handler = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    const consume = vi.fn().mockResolvedValue({
      allowed: false,
      limitedDimension: 'client_address',
      retryAfterSeconds: 5,
    });
    registerBetterAuthHandler(application, {
      handler,
      publicOrigin: 'https://pertexo.test',
      rateLimitConsumer: { consume },
      sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3_600 },
    });

    const write = await application.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/email',
      headers: { origin: 'https://pertexo.test' },
      payload: { email: 'ada@example.test', password: 'example-password' },
    });
    expect(write.statusCode).toBe(429);
    expect(write.headers['retry-after']).toBe('5');
    expect(consume.mock.calls[0]?.[0]).toMatchObject({
      endpointClass: 'identity_start',
      failureMode: 'closed',
    });

    const callback = await application.inject({
      method: 'GET',
      url: '/v1/auth/callback/google?code=example',
    });
    expect(callback.statusCode).toBe(429);
    expect(consume.mock.calls[1]?.[0]).toMatchObject({
      endpointClass: 'identity_callback',
      failureMode: 'closed',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed when distributed authentication admission is unavailable', async () => {
    const application = Fastify();
    applications.push(application);
    const handler = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    registerBetterAuthHandler(application, {
      handler,
      publicOrigin: 'https://pertexo.test',
      rateLimitConsumer: {
        consume: () =>
          Promise.reject(new Error('rate-limit backend unavailable')),
      },
      sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3_600 },
    });
    const response = await application.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      headers: { origin: 'https://pertexo.test' },
      payload: { email: 'ada@example.test' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: 'request.rate_limit_unavailable',
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
