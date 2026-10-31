import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionNotOAuth2Error,
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
import {
  OAuth2EndpointRefusedError,
  OAuth2ProviderUnavailableError,
  OAuth2TokenRefusedError,
} from '../../connections/oauth2/errors.js';

export const connectionProblems = [
  errorRegistration(InvalidConnectionCursorError, () => {
    return applicationError('request.invalid', {
      safeDetail: 'The connection cursor is invalid.',
    });
  }),
  errorRegistration(ConnectionNotFoundError, () => {
    return applicationError('resource.not_found');
  }),
  errorRegistration(ConnectionNotOAuth2Error, () => {
    return applicationError('connection.conflict', {
      safeDetail: 'This connection doesn’t sign in with OAuth2.',
    });
  }),
  errorRegistration(OAuth2EndpointRefusedError, (error) => {
    return applicationError('connection.oauth2_endpoint_refused', {
      safeDetail: `${error.field} points to an address this install doesn’t allow. Use a public https address, or ask an administrator to allow the private network.`,
      details: {
        issues: [
          {
            path: `credential.settings.${error.field}`,
            code: 'endpoint_refused',
            message: 'This address isn’t allowed on this install.',
          },
        ],
      },
    });
  }),
  errorRegistration(OAuth2TokenRefusedError, () => {
    return applicationError('connection.oauth2_token_refused', {
      safeDetail:
        'The service refused the sign-in. Check the client ID, secret and token URL.',
    });
  }),
  errorRegistration(OAuth2ProviderUnavailableError, () => {
    return applicationError('provider.unavailable', {
      safeDetail: 'The service’s token address didn’t answer. Try again soon.',
    });
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
