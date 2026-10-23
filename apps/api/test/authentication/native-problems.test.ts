import { apiProblemSchema } from '@pertexo/contracts';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerBetterAuthHandler } from '../../src/authentication/better-auth/fastify.js';

const mappings = [
  [
    403,
    'ALTERNATIVE_SIGN_IN_REQUIRED',
    403,
    'auth.alternative_required',
    'Another sign-in method required',
  ],
  [
    403,
    'ORGANIZATION_EMAIL_MANAGED',
    403,
    'auth.organization_email_managed',
    'Organization email address is managed',
  ],
  [
    400,
    'AUTHENTICATION_METHOD_LIMIT',
    400,
    'auth.method_limit',
    'Sign-in method limit reached',
  ],
  [
    403,
    'RECOVERY_PASSWORD_REQUIRED',
    403,
    'auth.recovery_required',
    'Recovery password required',
  ],
  [
    403,
    'SSO_REQUIRED',
    403,
    'auth.sso_required',
    'Organization sign-in required',
  ],
  [
    403,
    'EMAIL_NOT_VERIFIED',
    403,
    'auth.email_not_verified',
    'Email verification required',
  ],
  [
    400,
    'INVALID_TOKEN',
    400,
    'auth.reset_link_invalid',
    'Reset link invalid or expired',
  ],
  [
    401,
    'INVALID_TOKEN',
    401,
    'auth.unauthenticated',
    'Authentication required',
  ],
  [403, 'INVALID_TOKEN', 403, 'auth.forbidden', 'Forbidden'],
  [404, 'UNKNOWN', 404, 'resource.not_found', 'Resource not found'],
  [409, 'UNKNOWN', 409, 'auth.conflict', 'Authentication change conflict'],
  [
    429,
    'ACCOUNT_TEMPORARILY_LOCKED',
    429,
    'auth.two_factor_locked',
    'Two-factor sign-in temporarily locked',
  ],
  [429, 'UNKNOWN', 429, 'request.rate_limited', 'Too many requests'],
  [
    503,
    'UNKNOWN',
    503,
    'provider.unavailable',
    'Authentication temporarily unavailable',
  ],
  [400, 'UNKNOWN', 400, 'request.invalid', 'Invalid request'],
  [422, 'INVALID_TOKEN', 400, 'request.invalid', 'Invalid request'],
  [418, 'UNKNOWN', 500, 'internal.unexpected', 'Authentication unavailable'],
  [
    500,
    'EMAIL_NOT_VERIFIED',
    500,
    'internal.unexpected',
    'Authentication unavailable',
  ],
] as const;

describe('native authentication problem transport', () => {
  it.each(mappings)(
    'maps HTTP %i / %s without exposing provider details',
    async (status, nativeCode, expectedStatus, code, title) => {
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
