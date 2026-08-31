import {
  IdentityConflictError,
  IdempotencyRequestConflictError,
  WorkspaceLifecycleConflictError,
} from '@pertexo/database/testing';
import { describe, expect, it } from 'vitest';

import { IdentityError } from '../../src/identity/index.js';
import { APPLICATION_ERROR_CATALOG } from '../../src/platform/http/index.js';
import { mapIdentityWorkspaceError } from '../../src/identity-workspace/index.js';

describe('identity/workspace conflict mapping', () => {
  it('maps identity provider outages to the stable safe 503 catalog code', () => {
    const error = mapIdentityWorkspaceError(
      new IdentityError('identity.provider_unavailable'),
    );

    expect(error).toMatchObject({
      code: 'provider.unavailable',
      safeDetail: 'The identity provider is temporarily unavailable.',
    });
    expect(APPLICATION_ERROR_CATALOG[error.code]).toMatchObject({
      status: 503,
      title: 'Provider unavailable',
    });
  });

  it.each([
    'identity.provider_rejected',
    'identity.transaction_replayed',
    'identity.nonce_mismatch',
  ] as const)('keeps rejected identity callback %s on a safe 4xx', (code) => {
    const identityError = new IdentityError(code);
    const error = mapIdentityWorkspaceError(identityError);

    expect(identityError.status).toBe(400);
    expect(error).toEqual({
      code: 'request.invalid',
      safeDetail: identityError.message,
    });
    expect(APPLICATION_ERROR_CATALOG[error.code].status).toBe(400);
  });

  it('maps a duplicate workspace slug to the stable 409 problem code', () => {
    const error = mapIdentityWorkspaceError(
      new IdentityConflictError('unsafe database detail', {
        reason: 'workspace_slug',
      }),
    );

    expect(error).toEqual({
      code: 'workspace.conflict',
      safeDetail: 'The workspace slug is already in use.',
    });
    expect(APPLICATION_ERROR_CATALOG[error.code].status).toBe(409);
  });

  it('maps a reused idempotency key with changed input to the stable conflict', () => {
    const error = mapIdentityWorkspaceError(
      new IdempotencyRequestConflictError(),
    );

    expect(error).toEqual({
      code: 'request.idempotency_conflict',
      safeDetail: 'The idempotency key was already used for another request.',
    });
    expect(APPLICATION_ERROR_CATALOG[error.code].status).toBe(409);
  });

  it('maps invalid lifecycle state to 409 without exposing persistence detail', () => {
    const error = mapIdentityWorkspaceError(
      new WorkspaceLifecycleConflictError(
        'invalid_state',
        'unsafe workspace state detail',
      ),
    );

    expect(error).toEqual({
      code: 'workspace.conflict',
      safeDetail: 'The workspace is not in a valid state for this operation.',
    });
    expect(APPLICATION_ERROR_CATALOG[error.code].status).toBe(409);
    expect(JSON.stringify(error)).not.toContain('unsafe');
  });

  it('keeps an inactive actor forbidden instead of classifying access as state conflict', () => {
    const error = mapIdentityWorkspaceError(
      new WorkspaceLifecycleConflictError(
        'actor_inactive',
        'unsafe membership detail',
      ),
    );

    expect(error).toEqual({
      code: 'auth.forbidden',
      safeDetail: 'The workspace cannot perform this lifecycle operation.',
    });
    expect(APPLICATION_ERROR_CATALOG[error.code].status).toBe(403);
  });
});
