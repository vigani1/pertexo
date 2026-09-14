import {
  IdentityConflictError,
  IdempotencyRequestConflictError,
  WorkspaceAccessDeniedError,
  WorkspaceLifecycleConflictError,
} from '@pertexo/database/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { IdentityError } from '../../src/identity/index.js';
import { APPLICATION_ERROR_CATALOG } from '../../src/platform/http/index.js';
import { mapIdentityWorkspaceError } from '../../src/identity-workspace/index.js';

describe('identity/workspace conflict mapping', () => {
  it('maps a stale member-read authorization to safe forbidden', () => {
    const error = mapIdentityWorkspaceError(
      new WorkspaceAccessDeniedError('unsafe membership detail'),
    );
    expect(error).toEqual({
      code: 'auth.forbidden',
      safeDetail: 'The actor is no longer authorized for this workspace.',
    });
  });

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

  it('maps a generic identity conflict without persistence detail', () => {
    const error = mapIdentityWorkspaceError(
      new IdentityConflictError('credential secret must not escape', {
        reason: 'identity',
      }),
    );

    expect(error).toEqual({
      code: 'request.invalid',
      safeDetail: 'The request conflicts with existing identity data.',
    });
    expect(JSON.stringify(error)).not.toContain('credential secret');
  });

  it.each([
    'identity.session_invalid',
    'identity.session_expired',
    'identity.session_revoked',
  ] as const)('maps %s to unauthenticated', (code) => {
    expect(mapIdentityWorkspaceError(new IdentityError(code))).toEqual({
      code: 'auth.unauthenticated',
    });
  });

  it('maps CSRF failure separately from session authentication', () => {
    expect(
      mapIdentityWorkspaceError(new IdentityError('identity.csrf_failed')),
    ).toEqual({
      code: 'auth.forbidden',
      safeDetail: 'The request could not be verified.',
    });
  });

  it('maps a Zod failure to a generic invalid request', () => {
    const parsed = z.string().min(2).safeParse('x');
    if (parsed.success) throw new Error('expected fixture validation failure');

    expect(mapIdentityWorkspaceError(parsed.error)).toEqual({
      code: 'request.invalid',
      safeDetail: 'The request is invalid.',
    });
  });

  it('retains an unknown cause only on an internal application error', () => {
    const cause = new Error('database password=secret');
    const error = mapIdentityWorkspaceError(cause);

    expect(error).toMatchObject({ code: 'internal.unexpected', cause });
    expect(error).not.toHaveProperty('safeDetail');
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
