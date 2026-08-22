import {
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionUnavailableError,
} from '@pertexo/database';
import { ConnectionSecretEncryptionError } from '@pertexo/integrations/server';
import { z } from 'zod';

import {
  applicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import { AuthorizationError } from '../workspaces/index.js';

export function mapConnectionError(error: unknown): ApplicationError {
  if (error instanceof z.ZodError)
    return applicationError('request.invalid', {
      safeDetail: 'The connection request is invalid.',
    });
  if (error instanceof AuthorizationError)
    return applicationError(error.code, { safeDetail: error.message });
  if (error instanceof ConnectionNotFoundError)
    return applicationError('resource.not_found');
  if (error instanceof ConnectionIdempotencyConflictError)
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  if (
    error instanceof ConnectionConflictError ||
    error instanceof ConnectionSecretVersionConflictError
  )
    return applicationError('connection.conflict', {
      safeDetail: 'The connection conflicts with current state.',
    });
  if (error instanceof ConnectionUnavailableError)
    return applicationError('connection.revoked', {
      safeDetail: 'The connection is not available.',
    });
  if (error instanceof ConnectionSecretEncryptionError)
    return applicationError('provider.unavailable', {
      safeDetail: 'Credential protection is temporarily unavailable.',
      cause: error,
    });
  return applicationError('internal.unexpected', { cause: error });
}

export function throwConnectionApplicationError(error: unknown): never {
  // The shared problem filter consumes frozen application errors.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw mapConnectionError(error);
}
