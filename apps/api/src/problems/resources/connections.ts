import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionSharingRevisionConflictError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from '@pertexo/database/connections';
import { FailureNotificationDestinationError } from '@pertexo/database/notifications';
import {
  ConnectionSecretEncryptionError,
  SecureHttpError,
} from '@pertexo/integrations/server';
import { applicationError } from '../../platform/http/index.js';
import { InvalidConnectionCursorError } from '../../connections/cursor.js';

export const connectionProblems = [
  errorRegistration(InvalidConnectionCursorError, () => {
    return applicationError('request.invalid', {
      safeDetail: 'The connection cursor is invalid.',
    });
  }),
  errorRegistration(ConnectionNotFoundError, () => {
    return applicationError('resource.not_found');
  }),
  errorRegistration(FailureNotificationDestinationError, (error) => {
    if (error.code === 'not_found') {
      return applicationError('resource.not_found');
    }
    if (error.code === 'idempotency_conflict') {
      return applicationError('request.idempotency_conflict', {
        safeDetail: 'The idempotency key was already used for another request.',
      });
    }
    return applicationError('connection.conflict', {
      safeDetail: 'The destination conflicts with current state.',
    });
  }),
  errorRegistration(ConnectionIdempotencyConflictError, () => {
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  }),
  errorRegistration(ConnectionSharingRevisionConflictError, () => {
    return applicationError('connection.conflict', {
      safeDetail:
        'Sharing changed since you opened it. Reload, then try again.',
    });
  }),
  errorRegistration(ConnectionConflictError, () => {
    return applicationError('connection.conflict', {
      safeDetail:
        'A connection with this name already exists for this service. Choose another name.',
    });
  }),
  errorRegistration(ConnectionSecretVersionConflictError, () => {
    return applicationError('connection.conflict', {
      safeDetail:
        'The connection’s secret changed since you opened it. Reload, then try again.',
    });
  }),
  errorRegistration(ConnectionTestInProgressError, () => {
    return applicationError('connection.conflict', {
      safeDetail:
        'A test of this connection is already running. Wait for it to finish.',
    });
  }),
  errorRegistration(ConnectionUnavailableError, () => {
    return applicationError('connection.revoked', {
      safeDetail: 'The connection is not available.',
    });
  }),
  errorRegistration(ConnectionSecretEncryptionError, (error) => {
    return applicationError('provider.unavailable', {
      safeDetail: 'Credential protection is temporarily unavailable.',
      cause: error,
    });
  }),
  errorRegistration(SecureHttpError, (error) => {
    return applicationError('provider.unavailable', {
      safeDetail: 'The connection test could not be dispatched safely.',
      cause: error,
    });
  }),
];
