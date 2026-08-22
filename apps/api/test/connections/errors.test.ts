import {
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionUnavailableError,
} from '@pertexo/database';
import { ConnectionSecretEncryptionError } from '@pertexo/integrations/server';
import { describe, expect, it } from 'vitest';

import { mapConnectionError } from '../../src/connections/errors.js';

describe('connection error mapping', () => {
  it('maps persistence conflicts to stable bounded public problems', () => {
    expect(mapConnectionError(new ConnectionNotFoundError())).toMatchObject({
      code: 'resource.not_found',
    });
    expect(
      mapConnectionError(new ConnectionIdempotencyConflictError()),
    ).toMatchObject({ code: 'request.idempotency_conflict' });
    expect(mapConnectionError(new ConnectionConflictError())).toMatchObject({
      code: 'connection.conflict',
    });
    expect(mapConnectionError(new ConnectionUnavailableError())).toMatchObject({
      code: 'connection.revoked',
    });
  });

  it('maps KMS failure to a safe provider problem without exposing its cause', () => {
    const sensitive = 'kms-account-secret';
    const failure = new ConnectionSecretEncryptionError();
    const mapped = mapConnectionError(failure);
    expect(mapped).toMatchObject({
      code: 'provider.unavailable',
      safeDetail: 'Credential protection is temporarily unavailable.',
    });
    expect(failure).not.toHaveProperty('cause');
    expect(JSON.stringify(mapped)).not.toContain(sensitive);
  });
});
