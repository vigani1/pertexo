import {
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  FailureNotificationDestinationError,
} from '@pertexo/database/testing';
import {
  ConnectionSecretEncryptionError,
  SecureHttpError,
} from '@pertexo/integrations/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { mapConnectionError } from '../../src/connections/errors.js';
import { InvalidAuthenticatedWorkspaceContextError } from '../../src/identity-workspace/authenticated-command-context-error.js';
import { InvalidIdempotencyKeyError } from '../../src/platform/http/index.js';
import { AuthorizationError } from '../../src/workspaces/index.js';

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
      'connection state conflict',
      new ConnectionConflictError(),
      'connection.conflict',
      'The connection conflicts with current state.',
    ],
    [
      'secret version conflict',
      new ConnectionSecretVersionConflictError(),
      'connection.conflict',
      'The connection conflicts with current state.',
    ],
    [
      'test already in progress',
      new ConnectionTestInProgressError(),
      'connection.conflict',
      'The connection conflicts with current state.',
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
      new InvalidIdempotencyKeyError(),
      'request.invalid',
      'Idempotency-Key must contain exactly one valid value',
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
      expect(mapConnectionError(failure)).toEqual({
        code,
        ...(safeDetail === undefined ? {} : { safeDetail }),
      });
    },
  );

  it('retains KMS failure only as an internal cause of a safe problem', () => {
    const failure = new ConnectionSecretEncryptionError();
    expect(mapConnectionError(failure)).toEqual({
      code: 'provider.unavailable',
      safeDetail: 'Credential protection is temporarily unavailable.',
      cause: failure,
    });
  });

  it('retains transport failure only as an internal cause of a safe problem', () => {
    const failure = new SecureHttpError(
      'dispatch_evidence_failed',
      'definite_failure',
      false,
    );
    expect(mapConnectionError(failure)).toEqual({
      code: 'provider.unavailable',
      safeDetail: 'The connection test could not be dispatched safely.',
      cause: failure,
    });
  });

  it('maps an unknown failure to an internal problem with exact diagnostic cause', () => {
    const failure = Object.freeze({ secret: 'not-for-the-wire' });
    expect(mapConnectionError(failure)).toEqual({
      code: 'internal.unexpected',
      cause: failure,
    });
  });
});
