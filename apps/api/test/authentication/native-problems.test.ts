import { apiProblemSchema } from '@pertexo/contracts';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerBetterAuthHandler } from '../../src/authentication/better-auth/fastify.js';

const mappings = [
  [
    403,
    'ALTERNATIVE_SIGN_IN_REQUIRED',
    {
      status: 403,
      code: 'auth.alternative_required',
      title: 'Another sign-in method required',
    },
  ],
  [
    403,
    'ORGANIZATION_EMAIL_MANAGED',
    {
      status: 403,
      code: 'auth.organization_email_managed',
      title: 'Organization email address is managed',
    },
  ],
  [
    400,
    'AUTHENTICATION_METHOD_LIMIT',
    {
      status: 400,
      code: 'auth.method_limit',
      title: 'Sign-in method limit reached',
    },
  ],
  [
    403,
    'RECOVERY_PASSWORD_REQUIRED',
    {
      status: 403,
      code: 'auth.recovery_required',
      title: 'Recovery password required',
    },
  ],
  [
    403,
    'SSO_REQUIRED',
    {
      status: 403,
      code: 'auth.sso_required',
      title: 'Organization sign-in required',
    },
  ],
  [
    403,
    'EMAIL_NOT_VERIFIED',
    {
      status: 403,
      code: 'auth.email_not_verified',
      title: 'Email verification required',
    },
  ],
  [
    400,
    'INVALID_TOKEN',
    {
      status: 400,
      code: 'auth.reset_link_invalid',
      title: 'Reset link invalid or expired',
    },
  ],
  [
    401,
    'INVALID_TOKEN',
    {
      status: 401,
      code: 'auth.unauthenticated',
      title: 'Authentication required',
    },
  ],
  [
    403,
    'INVALID_TOKEN',
    { status: 403, code: 'auth.forbidden', title: 'Forbidden' },
  ],
  [
    404,
    'UNKNOWN',
    { status: 404, code: 'resource.not_found', title: 'Resource not found' },
  ],
  [
    409,
    'UNKNOWN',
    {
      status: 409,
      code: 'auth.conflict',
      title: 'Authentication change conflict',
    },
  ],
  [
    429,
    'ACCOUNT_TEMPORARILY_LOCKED',
    {
      status: 429,
      code: 'auth.two_factor_locked',
      title: 'Two-factor sign-in temporarily locked',
    },
  ],
  [
    429,
    'UNKNOWN',
    { status: 429, code: 'request.rate_limited', title: 'Too many requests' },
  ],
  [
    503,
    'UNKNOWN',
    {
      status: 503,
      code: 'provider.unavailable',
      title: 'Authentication temporarily unavailable',
    },
  ],
  [
    400,
    'UNKNOWN',
    { status: 400, code: 'request.invalid', title: 'Invalid request' },
  ],
  [
    422,
    'INVALID_TOKEN',
    { status: 400, code: 'request.invalid', title: 'Invalid request' },
  ],
  [
    418,
    'UNKNOWN',
    {
      status: 500,
      code: 'internal.unexpected',
      title: 'Authentication unavailable',
    },
  ],
  [
    500,
    'EMAIL_NOT_VERIFIED',
    {
      status: 500,
      code: 'internal.unexpected',
      title: 'Authentication unavailable',
    },
  ],
] as const;

describe('native authentication problem transport', () => {
  it.each(mappings)(
    'maps HTTP %i / %s without exposing provider details',
    async (status, nativeCode, expected) => {
      const { status: expectedStatus, code, title } = expected;

      const application = Fastify();
      registerBetterAuthHandler(application, {
        publicOrigin: 'https://pertexo.test',
        rateLimitConsumer: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
        sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3600 },
        handler: () =>
          Promise.resolve(
            Response.json(
              {
                code: nativeCode,
                message: 'private provider message',
                token: 'private-token',
              },
              { status, headers: { 'retry-after': '17' } },
            ),
          ),
      });
      try {
        const response = await application.inject({
          method: 'POST',
          url: '/v1/auth/sign-in/email',
          headers: { origin: 'https://pertexo.test' },
          payload: {},
        });
        expect(response.statusCode).toBe(expectedStatus);
        expect(apiProblemSchema.parse(response.json())).toEqual({
          type: `urn:pertexo:problem:${code}`,
          status: expectedStatus,
          code,
          title,
          requestId: response.headers['x-request-id'],
        });
        expect(response.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(response.headers['retry-after']).toBe('17');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.payload).not.toContain('private');
        expect(response.payload).not.toContain(nativeCode);
      } finally {
        await application.close();
      }
    },
  );

  it.each([
    'not JSON',
    'null',
    '[]',
    '{"code":42}',
    '{"code":{"secret":"private"}}',
  ])('fails closed for malformed native error body %s', async (body) => {
    const application = Fastify();
    registerBetterAuthHandler(application, {
      publicOrigin: 'https://pertexo.test',
      rateLimitConsumer: {
        consume: () => Promise.resolve({ allowed: true as const }),
      },
      sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3600 },
      handler: () => Promise.resolve(new Response(body, { status: 400 })),
    });
    try {
      const response = await application.inject({
        method: 'GET',
        url: '/v1/auth/callback/example',
      });
      expect(response.statusCode).toBe(400);
      expect(apiProblemSchema.parse(response.json())).toMatchObject({
        code: 'request.invalid',
        title: 'Invalid request',
      });
      expect(response.payload).not.toContain('private');
    } finally {
      await application.close();
    }
  });
});
