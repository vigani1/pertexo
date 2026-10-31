import type { FastifyReply } from 'fastify';
import { API_PROBLEM_MANIFEST } from '@pertexo/contracts';
import type { ApiProblemCode } from '@pertexo/contracts';

export function sendProblem(
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
    '403:SIGN_UP_CLOSED',
    {
      status: 403,
      code: 'auth.sign_up_closed',
      title: 'Sign-up is by invitation',
    },
  ],
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

export function normalizedNativeError(
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
