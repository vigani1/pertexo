import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import {
  registerAuthenticationCapabilities,
  registerBetterAuthHandler,
} from '../../../src/authentication/better-auth/fastify.js';
import { allowingRateLimit, applications } from './fixture.js';

export function registerServesConfiguredCapabilitiesBootstrapsApplicationCSRF(): void {
  it('serves configured capabilities and bootstraps application CSRF with a session', async () => {
    const application = Fastify();
    applications.push(application);
    registerAuthenticationCapabilities(
      application,
      {
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: ['google'],
      },
      () => Promise.resolve(true),
    );
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
      signUp: 'open',
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

  it.each(['verify-totp', 'verify-backup-code'])(
    'keeps %s token-free and in the distributed sign-in rate limit',
    async (path) => {
      const application = Fastify();
      applications.push(application);
      const handler = vi.fn(() =>
        Promise.resolve(
          Response.json(
            { token: 'private-token', user: { id: 'user' } },
            {
              headers: {
                'set-cookie':
                  'pertexo_session=signed-session; HttpOnly; Path=/',
              },
            },
          ),
        ),
      );
      const consume = vi
        .fn()
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValue({
          allowed: false,
          limitedDimension: 'client_address',
          retryAfterSeconds: 5,
        });
      registerBetterAuthHandler(application, {
        handler,
        publicOrigin: 'https://pertexo.test',
        rateLimitConsumer: { consume },
        sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3600 },
      });
      const request = {
        method: 'POST' as const,
        url: `/v1/auth/two-factor/${path}`,
        headers: { origin: 'https://pertexo.test' },
        payload: { code: '123456' },
      };
      const accepted = await application.inject(request);
      expect(accepted.json()).toEqual({ user: { id: 'user' } });
      expect(accepted.headers['set-cookie']).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^pertexo_session=/u),
          expect.stringMatching(/^pertexo_csrf=/u),
        ]),
      );
      const refused = await application.inject(request);
      expect(refused.statusCode).toBe(429);
      expect(consume.mock.calls[1]?.[0]).toMatchObject({
        endpointClass: 'identity_start',
        failureMode: 'closed',
      });
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );

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
    const form = await application.inject({
      method: 'POST',
      url: '/v1/auth/federation/social/callback/apple',
      headers: {
        origin: 'https://appleid.apple.com',
        'content-type': 'application/json',
      },
      payload: { code: 'example' },
    });
    expect(form.statusCode).toBe(429);
    expect(consume.mock.calls[2]?.[0]).toMatchObject({
      endpointClass: 'identity_callback',
      failureMode: 'closed',
    });
    const saml = await application.inject({
      method: 'POST',
      url: '/v1/auth/federation/saml/callback',
      headers: { origin: 'https://idp.example.test' },
      payload: { SAMLResponse: 'example', RelayState: 'example' },
    });
    expect(saml.statusCode).toBe(429);
    expect(saml.headers['retry-after']).toBe('5');
    expect(consume.mock.calls[3]?.[0]).toMatchObject({
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
}
