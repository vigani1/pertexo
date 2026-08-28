import {
  IdentityConflictError,
  IdempotencyRequestConflictError,
  WorkspaceLifecycleConflictError,
} from '@pertexo/database/api';
import {
  applicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import { z } from 'zod';
import {
  AuthorizationError,
  type AuthorizationErrorCode,
} from '../workspaces/index.js';
import { isIdentityError, type IdentityError } from '../identity/index.js';

export function workspaceApplicationError(
  code: AuthorizationErrorCode,
  safeDetail?: string,
): ApplicationError {
  return applicationError(code, safeDetail === undefined ? {} : { safeDetail });
}

export function mapIdentityWorkspaceError(error: unknown): ApplicationError {
  if (error instanceof z.ZodError) {
    return applicationError('request.invalid', {
      safeDetail: 'The request is invalid.',
    });
  }
  if (error instanceof AuthorizationError) {
    return workspaceApplicationError(error.code, error.message);
  }
  if (isIdentityError(error)) {
    return mapIdentityError(error);
  }
  if (error instanceof WorkspaceLifecycleConflictError) {
    if (error.reason === 'invalid_state') {
      return applicationError('workspace.conflict', {
        safeDetail: 'The workspace is not in a valid state for this operation.',
      });
    }
    return applicationError('auth.forbidden', {
      safeDetail: 'The workspace cannot perform this lifecycle operation.',
    });
  }
  if (error instanceof IdentityConflictError) {
    if (error.reason === 'workspace_slug') {
      return applicationError('workspace.conflict', {
        safeDetail: 'The workspace slug is already in use.',
      });
    }
    return applicationError('request.invalid', {
      safeDetail: 'The request conflicts with existing identity data.',
    });
  }
  if (error instanceof IdempotencyRequestConflictError) {
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  }
  return applicationError('internal.unexpected', { cause: error });
}

function mapIdentityError(error: IdentityError): ApplicationError {
  if (
    error.code === 'identity.session_invalid' ||
    error.code === 'identity.session_expired' ||
    error.code === 'identity.session_revoked'
  ) {
    return applicationError('auth.unauthenticated');
  }
  if (error.code === 'identity.csrf_failed') {
    return applicationError('auth.forbidden', {
      safeDetail: 'The request could not be verified.',
    });
  }
  if (error.code === 'identity.provider_unavailable') {
    return applicationError('provider.unavailable', {
      safeDetail: 'The identity provider is temporarily unavailable.',
      cause: error,
    });
  }
  return applicationError('request.invalid', { safeDetail: error.message });
}

export function rethrowAsApplicationError(error: unknown): never {
  // The HTTP problem filter consumes this frozen application-error value.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw mapIdentityWorkspaceError(error);
}
