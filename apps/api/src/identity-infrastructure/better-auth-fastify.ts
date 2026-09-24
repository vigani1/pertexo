import { randomBytes, randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  authenticationCapabilitiesResponseSchema,
  type AuthenticationCapabilitiesResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiProblemCode } from '@pertexo/contracts/errors';
import { AbuseRateLimitPolicy } from '@pertexo/rate-limit';

import type { RateLimitConsumer } from '../platform/rate-limit/interceptor.js';
import type { BetterAuthRuntime } from './better-auth.js';

type AuthenticationHandler = BetterAuthRuntime['auth']['handler'];
const rateLimitPolicy = new AbuseRateLimitPolicy();

const BLOCKED_BROWSER_AUTH_PATHS = new Set([
  '/v1/auth/get-session',
  '/v1/auth/get-access-token',
  '/v1/auth/refresh-token',
  '/v1/auth/list-accounts',
  '/v1/auth/account-info',
  '/v1/auth/update-session',
  '/v1/auth/reset-password',
]);

const TOKEN_BEARING_RESPONSE_PATHS = new Set([
  '/v1/auth/sign-in/email',
  '/v1/auth/sign-up/email',
  '/v1/auth/sign-in/social',
  '/v1/auth/link-social',
]);

export function registerBetterAuthHandler(
  fastify: FastifyInstance,
  input: Readonly<{
    handler: AuthenticationHandler;
    rateLimitConsumer: RateLimitConsumer;
    publicOrigin: string;
    sessionCookie: Readonly<{
      secure: boolean;
      sameSite: 'lax' | 'strict' | 'none';
      maxAgeSeconds: number;
    }>;
  }>,
): void {
  const origin = new URL(input.publicOrigin).origin;
  fastify.all('/v1/auth/*', async (request, reply) => {
    await dispatchBetterAuthRequest(
      request,
      reply,
      input.handler,
      origin,
      input.sessionCookie,
      input.rateLimitConsumer,
    );
  });
}

export function registerAuthenticationCapabilities(
  fastify: FastifyInstance,
  capabilities: AuthenticationCapabilitiesResponse,
): void {
  const response = authenticationCapabilitiesResponseSchema.parse(capabilities);
  fastify.get('/v1/auth/capabilities', async (_request, reply) => {
    reply.send(response);
  });
}

async function dispatchBetterAuthRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  handler: AuthenticationHandler,
  publicOrigin: string,
  sessionCookie?: Readonly<{
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    maxAgeSeconds: number;
  }>,
  rateLimitConsumer?: RateLimitConsumer,
): Promise<void> {
  const pathname = canonicalAuthPath(
    new URL(request.url, publicOrigin).pathname,
  );
  const requestId = randomUUID();
  if (BLOCKED_BROWSER_AUTH_PATHS.has(pathname)) {
    sendProblem(
      reply,
      requestId,
      404,
      'resource.not_found',
      'Resource not found',
    );
    return;
  }
  if (
    isUnsafeMethod(request.method) &&
    request.headers.origin !== publicOrigin
  ) {
    sendProblem(
      reply,
      requestId,
      403,
      'auth.forbidden',
      'Authentication request rejected',
    );
    return;
  }
  if (rateLimitConsumer !== undefined) {
    const endpointClass = isUnsafeMethod(request.method)
      ? 'identity_start'
      : 'identity_callback';
    const decision = rateLimitPolicy.evaluate(endpointClass, {
      clientAddress: request.ip,
      origin: request.headers.origin ?? publicOrigin,
    });
    let allowed: Awaited<ReturnType<RateLimitConsumer['consume']>>;
    try {
      allowed = await rateLimitConsumer.consume(decision);
    } catch {
      reply.header('retry-after', '1');
      sendProblem(
        reply,
        requestId,
        503,
        'request.rate_limit_unavailable',
        'Authentication temporarily unavailable',
      );
      return;
    }
    if (!allowed.allowed) {
      reply.header(
        'retry-after',
        String(Math.max(1, allowed.retryAfterSeconds)),
      );
      sendProblem(
        reply,
        requestId,
        429,
        'request.rate_limited',
        'Too many authentication requests',
      );
      return;
    }
  }
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(request.headers)) {
    if (rawValue === undefined) continue;
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) headers.append(name, value);
    } else {
      headers.set(name, rawValue);
    }
  }

  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : requestBody(request);
  const response = await handler(
    new Request(new URL(request.url, publicOrigin), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );

  const responseBody = new Uint8Array(await response.arrayBuffer());
  const nativeError =
    response.status >= 400
      ? normalizedNativeError(response.status, responseBody, requestId)
      : undefined;
  reply.code(nativeError?.status ?? response.status);
  const setCookies = response.headers.getSetCookie();
  if (
    sessionCookie !== undefined &&
    setCookies.some(establishesPertexoSession) &&
    !setCookies.some((cookie) => cookie.startsWith('pertexo_csrf='))
  ) {
    setCookies.push(serializeCsrfCookie(sessionCookie));
  }
  for (const [name, value] of response.headers.entries()) {
    if (
      name.toLowerCase() !== 'set-cookie' &&
      name.toLowerCase() !== 'content-length' &&
      (nativeError === undefined || name.toLowerCase() !== 'content-type')
    )
      reply.header(name, value);
  }
  if (setCookies.length > 0) reply.header('set-cookie', setCookies);
  if (nativeError !== undefined) {
    reply.header('x-request-id', requestId);
    reply.type('application/problem+json').send(nativeError.body);
    return;
  }
  reply.send(
    TOKEN_BEARING_RESPONSE_PATHS.has(pathname)
      ? tokenFreeAuthenticationBody(responseBody, response.headers)
      : responseBody,
  );
}

function sendProblem(
  reply: FastifyReply,
  requestId: string,
  status: number,
  code: ApiProblemCode,
  title: string,
): void {
  reply
    .code(status)
    .header('x-request-id', requestId)
    .type('application/problem+json')
    .send({
      type: `urn:pertexo:problem:${code}`,
      title,
      status,
      code,
      requestId,
    });
}

function normalizedNativeError(
  status: number,
  body: Uint8Array,
  requestId: string,
): Readonly<{ status: number; body: string }> {
  let nativeCode: unknown;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    nativeCode =
      typeof parsed === 'object' && parsed !== null && 'code' in parsed
        ? parsed.code
        : undefined;
  } catch {
    nativeCode = undefined;
  }
  const mapped =
    status === 403 && nativeCode === 'EMAIL_NOT_VERIFIED'
      ? {
          status: 403,
          code: 'auth.email_not_verified',
          title: 'Email verification required',
        }
      : status === 400 && nativeCode === 'INVALID_TOKEN'
        ? {
            status: 400,
            code: 'auth.reset_link_invalid',
            title: 'Reset link invalid or expired',
          }
        : status === 401
          ? {
              status,
              code: 'auth.unauthenticated',
              title: 'Authentication required',
            }
          : status === 403
            ? { status, code: 'auth.forbidden', title: 'Forbidden' }
            : status === 404
              ? {
                  status,
                  code: 'resource.not_found',
                  title: 'Resource not found',
                }
              : status === 409
                ? {
                    status,
                    code: 'auth.conflict',
                    title: 'Authentication change conflict',
                  }
                : status === 429
                  ? {
                      status,
                      code: 'request.rate_limited',
                      title: 'Too many requests',
                    }
                  : status === 503
                    ? {
                        status,
                        code: 'provider.unavailable',
                        title: 'Authentication temporarily unavailable',
                      }
                    : status === 400 || status === 422
                      ? {
                          status: 400,
                          code: 'request.invalid',
                          title: 'Invalid request',
                        }
                      : {
                          status: 500,
                          code: 'internal.unexpected',
                          title: 'Authentication unavailable',
                        };
  return {
    status: mapped.status,
    body: JSON.stringify({
      type: `urn:pertexo:problem:${mapped.code}`,
      title: mapped.title,
      status: mapped.status,
      code: mapped.code,
      requestId,
    }),
  };
}

function canonicalAuthPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;
}

function tokenFreeAuthenticationBody(
  body: Uint8Array,
  headers: Headers,
): Uint8Array {
  if (!headers.get('content-type')?.includes('application/json')) return body;
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return new TextEncoder().encode(JSON.stringify(removeTokenFields(value)));
  } catch {
    return body;
  }
}

function removeTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeTokenFields);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, field]) =>
      isTokenField(name) ? [] : [[name, removeTokenFields(field)]],
    ),
  );
}

function isTokenField(name: string): boolean {
  return ['token', 'accessToken', 'refreshToken', 'idToken'].includes(name);
}

function establishesPertexoSession(cookie: string): boolean {
  return (
    cookie.startsWith('pertexo_session=') &&
    !/(?:^|;)\s*Max-Age=0(?:;|$)/iu.test(cookie)
  );
}

function serializeCsrfCookie(
  options: Readonly<{
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    maxAgeSeconds: number;
  }>,
): string {
  return [
    `pertexo_csrf=${randomBytes(32).toString('base64url')}`,
    'Path=/',
    options.secure ? 'Secure' : undefined,
    `SameSite=${options.sameSite[0]?.toUpperCase() ?? ''}${options.sameSite.slice(1)}`,
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}

function isUnsafeMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function requestBody(
  request: FastifyRequest,
): string | Uint8Array | URLSearchParams | undefined {
  const body: unknown = request.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  const contentType = request.headers['content-type'] ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    if (typeof body !== 'object') return undefined;
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(body)) {
      if (typeof value === 'string') form.append(name, value);
    }
    return form;
  }
  return JSON.stringify(body);
}
