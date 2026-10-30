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
  fastify.addHook('onRequest', async (_request, reply) => {
    reply.headers(API_RESPONSE_SECURITY_HEADERS);
  });
}
