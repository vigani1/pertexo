import type { UserProfileResponse } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { getCurrentUser } from '../../data/auth.api';

class SessionIdentityChangedError extends Error {
  public override readonly name = 'SessionIdentityChangedError';

  public constructor() {
    super('The authenticated identity changed while this editor was open.');
  }
}

class SessionIdentityUnverifiedError extends Error {
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

/** Who answers for this browser now, against the account a paused page belongs to. */
export type SessionOwnerCheck =
  | Readonly<{ kind: 'same'; user: UserProfileResponse }>
  | Readonly<{ kind: 'other'; user: UserProfileResponse }>
  | Readonly<{ kind: 'signed-out' }>
  | Readonly<{ kind: 'unreachable' }>;

export async function checkSessionOwner(
  apiClient: ApiClient,
  expectedUserId: string,
): Promise<SessionOwnerCheck> {
  try {
    const user = await getCurrentUser(apiClient);
    return user.id === expectedUserId
      ? { kind: 'same', user }
      : { kind: 'other', user };
  } catch (error) {
    if (isApiError(error) && error.status === 401)
      return { kind: 'signed-out' };
    return { kind: 'unreachable' };
  }
}
