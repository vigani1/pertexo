import { randomUUID } from 'node:crypto';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { landProviderFormCallback } from '../../../src/authentication/journeys/form-callback.js';
import { registerNoticeUnsubscribeTransport } from '../../../src/notifications/preferences/transport.js';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';

import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerBetterAuthHandler } from '../../../src/authentication/better-auth/fastify.js';
import { allowingRateLimit, applications } from './fixture.js';

export function registerPreservesJSONBodiesOriginChecksEvery(): void {
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
    expect(rejected.headers['referrer-policy']).toBe('no-referrer');
    expect(rejected.headers['cache-control']).toBe('no-store');

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

  it('preserves authentication form bytes with the opaque unsubscribe transport registered', async () => {
    const adapter = new FastifyAdapter();
    const application = adapter.getInstance();
    applications.push(application);
    registerNoticeUnsubscribeTransport(adapter);
    const received: string[] = [];
    registerBetterAuthHandler(application, {
      publicOrigin: 'https://pertexo.test',
      rateLimitConsumer: allowingRateLimit,
      sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3_600 },
      handler: async (request) => {
        received.push(await request.text());
        return new Response(null, { status: 204 });
      },
    });
    const payload =
      'email=ada%2Btest%40example.test&password=with+spaces%26symbols&state=one&state=two';
    const response = await application.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/email',
      headers: {
        origin: 'https://pertexo.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload,
    });
    expect(response.statusCode, response.payload).toBe(204);
    expect(received).toEqual([payload]);
  });

  it('accepts only the exact provider form landings across origins', async () => {
    const adapter = new FastifyAdapter();
    const application = adapter.getInstance();
    applications.push(application);
    registerNoticeUnsubscribeTransport(adapter);
    registerBetterAuthHandler(application, {
      publicOrigin: 'https://pertexo.test',
      rateLimitConsumer: allowingRateLimit,
      sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3600 },
      handler: async (request) =>
        (await landProviderFormCallback(request)) ??
        new Response(null, { status: 404 }),
    });
    for (const path of [
      '/v1/auth/federation/social/callback/apple',
      '/v1/auth/account-security/methods/link/callback/apple',
    ]) {
      const response = await application.inject({
        method: 'POST',
        url: path,
        headers: {
          origin: 'https://appleid.apple.com',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'state=bound&code=one-use&id_token=untrusted',
      });
      expect(response.statusCode, response.payload).toBe(303);
      expect(response.headers.location).toBe(
        `https://pertexo.test${path}?state=bound&code=one-use`,
      );
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    }
    const oversized = await application.inject({
      method: 'POST',
      url: '/v1/auth/federation/social/callback/apple',
      headers: {
        origin: 'https://appleid.apple.com',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `unused=${'a'.repeat(32768)}`,
    });
    expect(oversized.statusCode, oversized.payload).toBe(400);
    expect(oversized.json()).toMatchObject({
      code: 'request.invalid',
      status: 400,
    });
    const rejected = await application.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/social',
      headers: { origin: 'https://appleid.apple.com' },
      payload: { provider: 'apple' },
    });
    expect(rejected.statusCode).toBe(403);
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
}
