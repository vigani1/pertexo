import { isApiError, type ApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { verifiedSignInPath } from '../model/return-path';
import type { SocialProvider } from '../model/social-provider';
import { socialSignInStartedSchema } from '@pertexo/contracts';

export class NativeAuthenticationError extends Error {
  public readonly status: number | undefined;
  public readonly code: string | undefined;
  public readonly kind: ApiError['kind'] | undefined;
  /** Bounded Retry-After from a rate-limited response. */
  public readonly retryAfterMs: number | undefined;

  public constructor(
    message: string,
    options: Readonly<{
      status?: number | undefined;
      code?: string | undefined;
      kind?: ApiError['kind'] | undefined;
      retryAfterMs?: number | undefined;
    }> = {},
  ) {
    super(message);
    this.name = 'NativeAuthenticationError';
    this.status = options.status;
    this.code = options.code;
    this.kind = options.kind;
    this.retryAfterMs = options.retryAfterMs;
  }
}

type RequestInput = Readonly<{
  path: `/v1/auth/${string}`;
  body: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}>;

async function postAuthentication<Value>(
  apiClient: ApiClient,
  input: RequestInput,
): Promise<Value> {
  try {
    return await apiClient.request({
      path: input.path,
      method: 'POST',
      body: input.body,
      csrf: 'external',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      response: { kind: 'json', decode: (value) => value as Value },
    });
  } catch (error) {
    if (input.signal?.aborted ?? false) throw error;
    if (isApiError(error))
      throw new NativeAuthenticationError(error.message, {
        status: error.status,
        code: error.problem?.code,
        kind: error.kind,
        retryAfterMs: error.retryAfterMs,
      });
    throw new NativeAuthenticationError(
      'The authentication service could not be reached.',
      { kind: 'network' },
    );
  }
}

export async function signInWithEmail(
  apiClient: ApiClient,
  input: Readonly<{ email: string; password: string }>,
  signal?: AbortSignal,
) {
  const result = await postAuthentication<unknown>(apiClient, {
    path: '/v1/auth/sign-in/email',
    body: { ...input, callbackURL: '/workspaces' },
    ...(signal === undefined ? {} : { signal }),
  });
  if (typeof result !== 'object' || result === null)
    throw new TypeError('The sign-in response was invalid.');
  return {
    twoFactorRedirect: Reflect.get(result, 'twoFactorRedirect') === true,
  };
}

export function signUpWithEmail(
  apiClient: ApiClient,
  input: Readonly<{
    displayName: string;
    email: string;
    password: string;
    returnTo?: string | undefined;
  }>,
  signal?: AbortSignal,
) {
  return postAuthentication<unknown>(apiClient, {
    path: '/v1/auth/sign-up/email',
    body: {
      name: input.displayName,
      email: input.email,
      password: input.password,
      callbackURL: verifiedSignInPath(input.returnTo),
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function resendVerificationEmail(
  apiClient: ApiClient,
  input: Readonly<{ email: string; returnTo?: string | undefined }>,
  signal?: AbortSignal,
) {
  return postAuthentication<unknown>(apiClient, {
    path: '/v1/auth/send-verification-email',
    body: {
      email: input.email,
      callbackURL: verifiedSignInPath(input.returnTo),
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function requestPasswordReset(
  apiClient: ApiClient,
  email: string,
  signal?: AbortSignal,
) {
  return postAuthentication<unknown>(apiClient, {
    path: '/v1/auth/request-password-reset',
    body: { email, redirectTo: '/reset-password' },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function resetPassword(
  apiClient: ApiClient,
  input: Readonly<{ token: string; password: string }>,
  signal?: AbortSignal,
) {
  return postAuthentication<unknown>(apiClient, {
    path: '/v1/auth/account-security/password/reset',
    body: { token: input.token, newPassword: input.password },
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Social sign-in returns to an allowlisted path, else the workspaces. */
export async function startSocialAuthentication(
  apiClient: ApiClient,
  provider: SocialProvider,
  signal?: AbortSignal,
  returnTo?: string,
): Promise<string> {
  const failed = new URLSearchParams({ socialError: 'true' });
  if (returnTo !== undefined) failed.set('returnTo', returnTo);
  const value = await postAuthentication<unknown>(apiClient, {
    path: '/v1/auth/sign-in/social',
    body: {
      provider,
      callbackURL: returnTo ?? '/workspaces',
      errorCallbackURL: `/login?${failed.toString()}`,
    },
    ...(signal === undefined ? {} : { signal }),
  });
  const decoded = socialSignInStartedSchema.safeParse(value);
  if (!decoded.success)
    throw new NativeAuthenticationError('The provider response was invalid.');
  const parsed = new URL(decoded.data.url);
  const unsafeProviderUrl =
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && parsed.hostname === 'localhost'));
  if (unsafeProviderUrl)
    throw new NativeAuthenticationError('The provider URL was rejected.');
  return parsed.toString();
}
