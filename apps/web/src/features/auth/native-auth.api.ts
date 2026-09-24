import { isApiError, type ApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';

type AuthenticationProvider = 'google' | 'microsoft' | 'github' | 'apple';

export class NativeAuthenticationError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly kind?: ApiError['kind'],
    /** Bounded Retry-After from a rate-limited response. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'NativeAuthenticationError';
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
    if (input.signal?.aborted === true) throw error;
    if (isApiError(error))
      throw new NativeAuthenticationError(
        error.message,
        error.status,
        error.problem?.code,
        error.kind,
        error.retryAfterMs,
      );
    throw new NativeAuthenticationError(
      'The authentication service could not be reached.',
      undefined,
      undefined,
      'network',
    );
  }
}

export function signInWithEmail(
  apiClient: ApiClient,
  input: Readonly<{ email: string; password: string }>,
  signal?: AbortSignal,
) {
  return postAuthentication<unknown>(apiClient, {
    path: '/v1/auth/sign-in/email',
    body: { ...input, callbackURL: '/workspaces' },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function signUpWithEmail(
  apiClient: ApiClient,
  input: Readonly<{ displayName: string; email: string; password: string }>,
  signal?: AbortSignal,
) {
  return postAuthentication<unknown>(apiClient, {
    path: '/v1/auth/sign-up/email',
    body: {
      name: input.displayName,
      email: input.email,
      password: input.password,
      callbackURL: '/login?verified=true',
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function resendVerificationEmail(
  apiClient: ApiClient,
  email: string,
  signal?: AbortSignal,
) {
  return postAuthentication<unknown>(apiClient, {
    path: '/v1/auth/send-verification-email',
    body: { email, callbackURL: '/login?verified=true' },
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

export async function startSocialAuthentication(
  apiClient: ApiClient,
  provider: AuthenticationProvider,
  signal?: AbortSignal,
): Promise<string> {
  const value = await postAuthentication<unknown>(apiClient, {
    path: '/v1/auth/sign-in/social',
    body: {
      provider,
      callbackURL: '/workspaces',
      errorCallbackURL: '/login?socialError=true',
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (typeof value !== 'object' || value === null)
    throw new NativeAuthenticationError('The provider response was invalid.');
  const url = 'url' in value ? value.url : undefined;
  if (typeof url !== 'string')
    throw new NativeAuthenticationError('The provider response was invalid.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost')
    throw new NativeAuthenticationError('The provider URL was rejected.');
  return parsed.toString();
}
