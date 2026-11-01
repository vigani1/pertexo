import { toProblem } from '../../src/problems/registry.js';
import { connectionFailure } from '../../src/problems/context/normalize.js';
import {
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  FailureNotificationDestinationError,
} from '@pertexo/core/testing';
import {
  ConnectionSecretEncryptionError,
  SecureHttpError,
} from '@pertexo/integrations/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InvalidAuthenticatedWorkspaceContextError } from '../../src/workspaces/request/authenticated-context-error.js';
import { applicationError } from '../../src/platform/http/index.js';
import { AuthorizationError } from '../../src/authorization/index.js';

describe('connection error mapping', () => {
  it.each([
    [
      'missing connection',
      new ConnectionNotFoundError(),
      'resource.not_found',
      undefined,
    ],
    [
      'connection idempotency conflict',
      new ConnectionIdempotencyConflictError(),
      'request.idempotency_conflict',
      'The idempotency key was already used for another request.',
    ],
    [
      'connection name taken',
      new ConnectionConflictError(),
      'connection.conflict',
      'A connection with this name already exists for this service. Choose another name.',
    ],
    [
      'secret version conflict',
      new ConnectionSecretVersionConflictError(),
      'connection.conflict',
      'The connection’s secret changed since you opened it. Reload, then try again.',
    ],
    [
      'test already in progress',
      new ConnectionTestInProgressError(),
      'connection.conflict',
      'A test of this connection is already running. Wait for it to finish.',
    ],
    [
      'revoked connection',
      new ConnectionUnavailableError(),
      'connection.revoked',
      'The connection is not available.',
    ],
    [
      'missing destination',
      new FailureNotificationDestinationError('not_found'),
      'resource.not_found',
      undefined,
    ],
    [
      'destination idempotency conflict',
      new FailureNotificationDestinationError('idempotency_conflict'),
      'request.idempotency_conflict',
      'The idempotency key was already used for another request.',
    ],
    [
      'destination state conflict',
      new FailureNotificationDestinationError('conflict'),
      'connection.conflict',
      'The destination conflicts with current state.',
    ],
    [
      'authorization denial',
      new AuthorizationError('auth.forbidden', 'Forbidden'),
      'auth.forbidden',
      'Forbidden',
    ],
    [
      'invalid authenticated context',
      new InvalidAuthenticatedWorkspaceContextError('Invalid actor'),
      'request.invalid',
      'Invalid actor',
    ],
    [
      'invalid idempotency key',
      applicationError('request.invalid', {
        safeDetail: 'Idempotency-Key must contain exactly one valid value.',
      }),
      'request.invalid',
      'Idempotency-Key must contain exactly one valid value.',
    ],
    [
      'invalid request schema',
      new z.ZodError([]),
      'request.invalid',
      'The connection request is invalid.',
    ],
  ] as const)(
    'maps %s to the exact bounded public problem',
    (_name, failure, code, safeDetail) => {
      expect(toProblem(connectionFailure(failure))).toEqual({
        code,
        ...(safeDetail === undefined ? {} : { safeDetail }),
      });
    },
  );

  it('retains KMS failure only as an internal cause of a safe problem', () => {
    const failure = new ConnectionSecretEncryptionError();
    expect(toProblem(connectionFailure(failure))).toEqual({
      code: 'provider.unavailable',
      safeDetail: 'Credential protection is temporarily unavailable.',
      cause: failure,
    });
  });

  it('retains transport failure only as an internal cause of a safe problem', () => {
    const failure = new SecureHttpError(
      'dispatch_evidence_failed',
      'definite_failure',
      { possiblyDispatched: false },
    );
    expect(toProblem(connectionFailure(failure))).toEqual({
      code: 'provider.unavailable',
      safeDetail: 'The connection test could not be dispatched safely.',
      cause: failure,
    });
  });

  it('maps an unknown failure to an internal problem with exact diagnostic cause', () => {
    const failure = Object.freeze({ secret: 'not-for-the-wire' });
    expect(toProblem(connectionFailure(failure))).toEqual({
      code: 'internal.unexpected',
      cause: failure,
    });
  });
});
