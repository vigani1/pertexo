import { randomUUID } from 'node:crypto';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteShorthandOptions,
} from 'fastify';
import {
  SAML_LIMITS,
  authenticationCapabilitiesResponseSchema,
  type AuthenticationCapabilitiesResponse,
} from '@pertexo/contracts';

import {
  AbuseRateLimitPolicy,
  type RateLimitEndpointClass,
} from '@pertexo/rate-limit';
import {
  admitRateLimit,
  type RateLimitConsumer,
  type RateLimitMetricRecorder,
} from '../../platform/rate-limit/admission.js';
import { createRateLimitMetricRecorder } from '../../platform/rate-limit/metrics.js';
import type { BetterAuthRuntime } from './runtime.js';
import { isProviderFormCallback } from '../journeys/form-callback.js';
import { TWO_FACTOR_VERIFICATION_PATHS } from './two-factor.js';
import { sendProblem, normalizedNativeError } from './transport/problems.js';
import {
  tokenFreeAuthenticationBody,
  establishesPertexoSession,
  serializeCsrfCookie,
} from './transport/credentials.js';

type AuthenticationHandler = BetterAuthRuntime['auth']['handler'];

type AuthenticationRateLimits = Readonly<
  Record<'start' | 'callback', RateLimitEndpointClass>
>;

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
  ...TWO_FACTOR_VERIFICATION_PATHS.map((path) => `/v1/auth${path}`),
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
  const metrics = createRateLimitMetricRecorder();
  const config = {
    rateLimit: { start: 'identity_start', callback: 'identity_callback' },
  } as const;
  const options: RouteShorthandOptions = {
    config,
    onSend: (_request, reply, payload, done) => {
      // Redirected pages must not receive callback proofs through Referer.
      reply
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'no-store');
      done(null, payload);
    },
  };
  const handler = (request: FastifyRequest, reply: FastifyReply) =>
    dispatchBetterAuthRequest(request, reply, {
      handler: input.handler,
      publicOrigin: origin,
      sessionCookie: input.sessionCookie,
      admission: {
        consumer: input.rateLimitConsumer,
        metrics,
        policies: config.rateLimit,
      },
    });
  fastify.post(
    '/v1/auth/federation/saml/callback',
    { ...options, config, bodyLimit: SAML_LIMITS.formBytes },
    handler,
  );
  fastify.all('/v1/auth/*', options, handler);
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

type AuthenticationDispatch = Readonly<{
  handler: AuthenticationHandler;
  publicOrigin: string;
  sessionCookie: Readonly<{
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    maxAgeSeconds: number;
  }>;
  admission: Readonly<{
    consumer: RateLimitConsumer;
    metrics: RateLimitMetricRecorder;
    policies: AuthenticationRateLimits;
  }>;
}>;

async function dispatchBetterAuthRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  { handler, publicOrigin, sessionCookie, admission }: AuthenticationDispatch,
): Promise<void> {
  const pathname = canonicalAuthPath(
    new URL(request.url, publicOrigin).pathname,
  );
  const requestId = randomUUID();
  const providerFormCallback = isProviderFormCallback(request.method, pathname);
  if (BLOCKED_BROWSER_AUTH_PATHS.has(pathname)) {
    sendProblem(reply, {
      requestId,
      status: 404,
      code: 'resource.not_found',
      title: 'Resource not found',
    });
    return;
  }
  const crossOriginWrite =
    isUnsafeMethod(request.method) &&
    request.headers.origin !== publicOrigin &&
    !providerFormCallback;
  if (crossOriginWrite) {
    sendProblem(reply, {
      requestId,
      status: 403,
      code: 'auth.forbidden',
      title: 'Authentication request rejected',
    });
    return;
  }
  const endpointClass =
    isUnsafeMethod(request.method) && !providerFormCallback
      ? admission.policies.start
      : admission.policies.callback;
  const admitted = await admitRateLimit(
    admission.consumer,
    admission.metrics,
    rateLimitPolicy.evaluate(endpointClass, {
      clientAddress: request.ip,
      ...namedAccount(request.body),
    }),
  );
  if (admitted.kind === 'unavailable') {
    reply.header('retry-after', '1');
    sendProblem(reply, {
      requestId,
      status: 503,
      code: 'request.rate_limit_unavailable',
      title: 'Authentication temporarily unavailable',
    });
    return;
  }
  if (admitted.kind === 'limited') {
    reply.header(
      'retry-after',
      String(Math.max(1, admitted.retryAfterSeconds)),
    );
    sendProblem(reply, {
      requestId,
      status: 429,
      code: 'request.rate_limited',
      title: 'Too many authentication requests',
    });
    return;
  }
  const response = await handler(authenticationRequest(request, publicOrigin));
  await sendAuthenticationResponse(reply, response, {
    pathname,
    sessionCookie,
    requestId,
  });
}

/** Which account a request is about, if it names one; `better-auth` checks the rest. */
function namedAccount(body: unknown): { account: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const email: unknown = Reflect.get(body, 'email');
  if (typeof email !== 'string') return undefined;
  const account = email.trim().toLowerCase();
  return account === '' ? undefined : { account };
}

function authenticationRequest(
  request: FastifyRequest,
  publicOrigin: string,
): Request {
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
  return new Request(new URL(request.url, publicOrigin), {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function sendAuthenticationResponse(
  reply: FastifyReply,
  response: Response,
  {
    pathname,
    sessionCookie,
    requestId,
  }: Pick<AuthenticationDispatch, 'sessionCookie'> &
    Readonly<{ pathname: string; requestId: string }>,
): Promise<void> {
  const responseBody = new Uint8Array(await response.arrayBuffer());
  const nativeError =
    response.status >= 400
      ? normalizedNativeError(response.status, responseBody, requestId)
      : undefined;
  reply.code(nativeError?.status ?? response.status);
  const setCookies = response.headers.getSetCookie();
  if (
    setCookies.some(establishesPertexoSession) &&
    !setCookies.some((cookie) => cookie.startsWith('pertexo_csrf='))
  ) {
    setCookies.push(serializeCsrfCookie(sessionCookie));
  }
  for (const [name, value] of response.headers.entries()) {
    const forwardHeader =
      name.toLowerCase() !== 'set-cookie' &&
      name.toLowerCase() !== 'content-length' &&
      (nativeError === undefined || name.toLowerCase() !== 'content-type');
    if (forwardHeader) reply.header(name, value);
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

function canonicalAuthPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;
}

function isUnsafeMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function requestBody(
  request: FastifyRequest,
): string | Uint8Array<ArrayBuffer> | URLSearchParams | undefined {
  const body: unknown = request.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new Uint8Array(body);
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
