import { OAUTH2_CALLBACK_PATH } from '@pertexo/contracts';
import type { FastifyInstance } from 'fastify';

/**
 * API responses are data, never pages. `/hooks` and `/v1/auth` reach the API
 * without passing nginx and share the app's origin, so a browser opening one
 * must have nothing it could run: no scripts, no origin, no framing.
 */
export const API_RESPONSE_SECURITY_HEADERS = Object.freeze({
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; sandbox",
  'x-content-type-options': 'nosniff',
});

/** Set when the request arrives, so refusals and errors carry them too. */
export function registerResponseSecurityHeaders(
  fastify: FastifyInstance,
): void {
  fastify.addHook('onRequest', async (request, reply) => {
    reply.headers(API_RESPONSE_SECURITY_HEADERS);
    // Its query holds a code and state: nothing may cache it or see it as a referrer.
    if (request.url.split('?', 1)[0] === OAUTH2_CALLBACK_PATH)
      reply.headers({
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
  });
}
