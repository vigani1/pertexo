import { randomBytes, randomUUID } from 'node:crypto';

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteShorthandOptions,
} from 'fastify';
import {
  API_PROBLEM_MANIFEST,
  SAML_LIMITS,
  authenticationCapabilitiesResponseSchema,
  type AuthenticationCapabilitiesResponse,
} from '@pertexo/contracts';
import type { ApiProblemCode } from '@pertexo/contracts';
import {
  AbuseRateLimitPolicy,
  type RateLimitEndpointClass,
} from '@pertexo/rate-limit';

import type { RateLimitConsumer } from '../../platform/rate-limit/interceptor.js';
import type { BetterAuthRuntime } from './runtime.js';
import { isProviderFormCallback } from '../journeys/form-callback.js';
import { TWO_FACTOR_VERIFICATION_PATHS } from './two-factor.js';

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
  const decision = rateLimitPolicy.evaluate(endpointClass, {
    clientAddress: request.ip,
    origin: request.headers.origin ?? publicOrigin,
  });
  let allowed: Awaited<ReturnType<RateLimitConsumer['consume']>>;
  try {
    allowed = await admission.consumer.consume(decision);
  } catch {
    reply.header('retry-after', '1');
    sendProblem(reply, {
      requestId,
      status: 503,
      code: 'request.rate_limit_unavailable',
      title: 'Authentication temporarily unavailable',
    });
    return;
  }
  if (!allowed.allowed) {
    reply.header('retry-after', String(Math.max(1, allowed.retryAfterSeconds)));
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

function sendProblem(
  reply: FastifyReply,
  {
    requestId,
    status,
    code,
    title,
  }: Readonly<{
    requestId: string;
    status: number;
    code: ApiProblemCode;
    title: string;
  }>,
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

type NativeProblem = Readonly<{
  status: number;
  code: ApiProblemCode;
  title: string;
}>;
const NATIVE_PROBLEMS = new Map<string, NativeProblem>([
  [
    '403:ALTERNATIVE_SIGN_IN_REQUIRED',
    {
      status: 403,
      code: 'auth.alternative_required',
      title: 'Another sign-in method required',
    },
  ],
  [
    '403:ORGANIZATION_EMAIL_MANAGED',
    {
      status: 403,
      code: 'auth.organization_email_managed',
      title: 'Organization email address is managed',
    },
  ],
  [
    '400:AUTHENTICATION_METHOD_LIMIT',
    {
      status: 400,
      code: 'auth.method_limit',
      title: 'Sign-in method limit reached',
    },
  ],
  [
    '403:RECOVERY_PASSWORD_REQUIRED',
    {
      status: 403,
      code: 'auth.recovery_required',
      title: 'Recovery password required',
    },
  ],
  [
    '403:SSO_REQUIRED',
    {
      status: 403,
      code: 'auth.sso_required',
      title: 'Organization sign-in required',
    },
  ],
  [
    '403:EMAIL_NOT_VERIFIED',
    {
      status: 403,
      code: 'auth.email_not_verified',
      title: 'Email verification required',
    },
  ],
  [
    '400:INVALID_TOKEN',
    {
      status: 400,
      code: 'auth.reset_link_invalid',
      title: 'Reset link invalid or expired',
    },
  ],
  [
    '429:ACCOUNT_TEMPORARILY_LOCKED',
    {
      status: 429,
      code: 'auth.two_factor_locked',
      title: API_PROBLEM_MANIFEST['auth.two_factor_locked'].title,
    },
  ],
]);
const STATUS_PROBLEMS = new Map<number, NativeProblem>([
  [
    401,
    {
      status: 401,
      code: 'auth.unauthenticated',
      title: 'Authentication required',
    },
  ],
  [403, { status: 403, code: 'auth.forbidden', title: 'Forbidden' }],
  [
    404,
    { status: 404, code: 'resource.not_found', title: 'Resource not found' },
  ],
  [
    409,
    {
      status: 409,
      code: 'auth.conflict',
      title: 'Authentication change conflict',
    },
  ],
  [
    429,
    { status: 429, code: 'request.rate_limited', title: 'Too many requests' },
  ],
  [
    503,
    {
      status: 503,
      code: 'provider.unavailable',
      title: 'Authentication temporarily unavailable',
    },
  ],
  [400, { status: 400, code: 'request.invalid', title: 'Invalid request' }],
  [422, { status: 400, code: 'request.invalid', title: 'Invalid request' }],
]);
const UNEXPECTED_PROBLEM: NativeProblem = {
  status: 500,
  code: 'internal.unexpected',
  title: 'Authentication unavailable',
};

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
  const specific =
    typeof nativeCode === 'string'
      ? NATIVE_PROBLEMS.get(`${String(status)}:${nativeCode}`)
      : undefined;
  const mapped = specific ?? STATUS_PROBLEMS.get(status) ?? UNEXPECTED_PROBLEM;
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
