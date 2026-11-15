import { HttpStatus } from '@nestjs/common';
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

/**
 * Better Auth refuses what was typed with a 401. Clients read a 401 as an
 * ended session, so these leave as 400, like auth.invalid_password.
 */
function refused(
  code:
    | 'auth.invalid_credentials'
    | 'auth.two_factor_code_invalid'
    | 'auth.two_factor_challenge_expired',
): NativeProblem {
  return {
    status: HttpStatus.BAD_REQUEST,
    code,
    title: API_PROBLEM_MANIFEST[code].title,
  };
}

const NATIVE_PROBLEMS = new Map<string, NativeProblem>([
  // Better Auth answers every refusal with 401. Only a missing or ended
  // session may reach clients as auth.unauthenticated, which ends theirs.
  ['401:INVALID_EMAIL_OR_PASSWORD', refused('auth.invalid_credentials')],
  ['401:INVALID_TOKEN', refused('auth.invalid_credentials')],
  ['401:INVALID_CODE', refused('auth.two_factor_code_invalid')],
  ['401:INVALID_BACKUP_CODE', refused('auth.two_factor_code_invalid')],
  [
    '400:INVALID_PASSWORD',
    {
      status: HttpStatus.BAD_REQUEST,
      code: 'auth.invalid_password',
      title: API_PROBLEM_MANIFEST['auth.invalid_password'].title,
    },
  ],
  [
    '409:PASSWORD_ALREADY_CONFIGURED',
    {
      status: HttpStatus.CONFLICT,
      code: 'auth.password_already_configured',
      title: API_PROBLEM_MANIFEST['auth.password_already_configured'].title,
    },
  ],
  [
    '409:AUTHENTICATION_CHANGED',
    {
      status: HttpStatus.CONFLICT,
      code: 'auth.authentication_changed',
      title: API_PROBLEM_MANIFEST['auth.authentication_changed'].title,
    },
  ],
  [
    '403:SESSION_NOT_FRESH',
    {
      status: HttpStatus.FORBIDDEN,
      code: 'auth.session_not_fresh',
      title: 'Sign in again before changing account security settings.',
    },
  ],
  [
    '403:EMAIL_VERIFICATION_REQUIRED',
    {
      status: HttpStatus.FORBIDDEN,
      code: 'auth.email_not_verified',
      title: 'Verify your email before adding a password.',
    },
  ],
  [
    '404:AUTHENTICATION_METHOD_NOT_FOUND',
    {
      status: HttpStatus.NOT_FOUND,
      code: 'resource.not_found',
      title:
        'This sign-in method is no longer available. Reload security settings.',
    },
  ],
  [
    '400:CURRENT_SESSION_REQUIRES_LOGOUT',
    {
      status: HttpStatus.BAD_REQUEST,
      code: 'request.invalid',
      title: 'Sign out to end the current session.',
    },
  ],
  [
    '400:TRUST_DEVICE_DISABLED',
    {
      status: HttpStatus.BAD_REQUEST,
      code: 'request.invalid',
      title:
        'Use an authenticator or recovery code at every password sign-in. Trusted devices are disabled.',
    },
  ],

  [
    '400:LAST_AUTHENTICATION_METHOD',
    {
      status: HttpStatus.BAD_REQUEST,
      code: 'auth.last_method',
      title:
        'Add another working sign-in method allowed by your organization before removing this one.',
    },
  ],
  [
    '403:SIGN_UP_CLOSED',
    {
      status: HttpStatus.FORBIDDEN,
      code: 'auth.sign_up_closed',
      title: 'Sign-up is by invitation',
    },
  ],
  [
    '403:ALTERNATIVE_SIGN_IN_REQUIRED',
    {
      status: HttpStatus.FORBIDDEN,
      code: 'auth.alternative_required',
      title: 'Another sign-in method required',
    },
  ],
  [
    '403:ORGANIZATION_EMAIL_MANAGED',
    {
      status: HttpStatus.FORBIDDEN,
      code: 'auth.organization_email_managed',
      title: 'Organization email address is managed',
    },
  ],
  [
    '400:AUTHENTICATION_METHOD_LIMIT',
    {
      status: HttpStatus.BAD_REQUEST,
      code: 'auth.method_limit',
      title: 'Sign-in method limit reached',
    },
  ],
  [
    '403:RECOVERY_PASSWORD_REQUIRED',
    {
      status: HttpStatus.FORBIDDEN,
      code: 'auth.recovery_required',
      title: 'Recovery password required',
    },
  ],
  [
    '403:SSO_REQUIRED',
    {
      status: HttpStatus.FORBIDDEN,
      code: 'auth.sso_required',
      title: 'Organization sign-in required',
    },
  ],
  [
    '403:EMAIL_NOT_VERIFIED',
    {
      status: HttpStatus.FORBIDDEN,
      code: 'auth.email_not_verified',
      title: 'Email verification required',
    },
  ],
  [
    '400:INVALID_TOKEN',
    {
      status: HttpStatus.BAD_REQUEST,
      code: 'auth.reset_link_invalid',
      // session-setting-exempt: a problem title shown to people, not SQL
      title: 'Reset link invalid or expired',
    },
  ],
  [
    '429:ACCOUNT_TEMPORARILY_LOCKED',
    {
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'auth.two_factor_locked',
      title: API_PROBLEM_MANIFEST['auth.two_factor_locked'].title,
    },
  ],
]);

const STATUS_PROBLEMS = new Map<number, NativeProblem>([
  [
    401,
    {
      status: HttpStatus.UNAUTHORIZED,
      code: 'auth.unauthenticated',
      title: 'Authentication required',
    },
  ],
  [
    403,
    {
      status: HttpStatus.FORBIDDEN,
      code: 'auth.forbidden',
      title: 'Forbidden',
    },
  ],
  [
    404,
    {
      status: HttpStatus.NOT_FOUND,
      code: 'resource.not_found',
      title: 'Resource not found',
    },
  ],
  [
    409,
    {
      status: HttpStatus.CONFLICT,
      code: 'auth.conflict',
      title: 'Authentication change conflict',
    },
  ],
  [
    429,
    {
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'request.rate_limited',
      title: 'Too many requests',
    },
  ],
  [
    503,
    {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'provider.unavailable',
      title: 'Authentication temporarily unavailable',
    },
  ],
  [
    400,
    {
      status: HttpStatus.BAD_REQUEST,
      code: 'request.invalid',
      title: 'Invalid request',
    },
  ],
  [
    422,
    {
      status: HttpStatus.BAD_REQUEST,
      code: 'request.invalid',
      title: 'Invalid request',
    },
  ],
]);

const UNEXPECTED_PROBLEM: NativeProblem = {
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  code: 'internal.unexpected',
  title: 'Authentication unavailable',
};

/**
 * `carriesChallenge`: the request brought a two-factor sign-in challenge
 * cookie. Better Auth answers INVALID_TWO_FACTOR_COOKIE both when that
 * challenge expired and when a request has no session and no challenge at
 * all; only the first is an expired sign-in, the second an ended session.
 */
export function normalizedNativeError(
  status: number,
  body: Uint8Array,
  requestId: string,
  carriesChallenge = false,
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
  const challengeExpired =
    status === 401 &&
    nativeCode === 'INVALID_TWO_FACTOR_COOKIE' &&
    carriesChallenge;
  const listed =
    typeof nativeCode === 'string'
      ? NATIVE_PROBLEMS.get(`${String(status)}:${nativeCode}`)
      : undefined;
  const specific = challengeExpired
    ? refused('auth.two_factor_challenge_expired')
    : listed;
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
