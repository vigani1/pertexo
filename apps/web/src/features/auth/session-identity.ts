import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { getCurrentUser } from './auth.api';

export class SessionIdentityChangedError extends Error {
  public override readonly name = 'SessionIdentityChangedError';

  public constructor() {
    super('The authenticated identity changed while this editor was open.');
  }
}

export class SessionIdentityUnverifiedError extends Error {
  public override readonly name = 'SessionIdentityUnverifiedError';

  public constructor(cause: unknown) {
    super('The authenticated identity could not be verified.', { cause });
  }
}

export async function assertSessionIdentity(
  apiClient: ApiClient,
  expectedUserId: string,
  signal?: AbortSignal,
): ReturnType<typeof getCurrentUser> {
  try {
    const currentUser = await getCurrentUser(apiClient, signal);
    if (currentUser.id !== expectedUserId)
      throw new SessionIdentityChangedError();
    return currentUser;
  } catch (error) {
    if (
      error instanceof SessionIdentityChangedError ||
      (isApiError(error) && error.status === 401)
    )
      throw new SessionIdentityChangedError();
    if (isApiError(error) && error.kind === 'canceled') throw error;
    throw new SessionIdentityUnverifiedError(error);
  }
}

export function isSessionIdentityChangedError(
  error: unknown,
): error is SessionIdentityChangedError {
  return error instanceof SessionIdentityChangedError;
}

export function isSessionIdentityUnverifiedError(
  error: unknown,
): error is SessionIdentityUnverifiedError {
  return error instanceof SessionIdentityUnverifiedError;
}
