import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
  IdentityConflictError,
  IdempotencyRequestConflictError,
  WorkspaceAccessDeniedError,
  WorkspaceLifecycleConflictError,
  WorkspaceMemberRoleCommandConflictError,
  WorkspaceRenameCommandConflictError,
} from '@pertexo/database/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { IdentityError } from '../../src/identity/index.js';
import { APPLICATION_ERROR_CATALOG } from '../../src/platform/http/index.js';
import { mapIdentityWorkspaceError } from '../../src/identity-workspace/index.js';

describe('identity/workspace conflict mapping', () => {
  it.each([
    ['revision_conflict', 'workspace.revision_conflict', 412],
    ['workspace_inactive', 'workspace.conflict', 409],
    ['actor_inactive', 'auth.forbidden', 403],
  ] as const)('maps workspace-rename %s to %s', (reason, code, status) => {
    const error = mapIdentityWorkspaceError(
      new WorkspaceRenameCommandConflictError(reason, 'unsafe detail'),
    );
    expect(error.code).toBe(code);
    expect(APPLICATION_ERROR_CATALOG[error.code].status).toBe(status);
    expect(JSON.stringify(error)).not.toContain('unsafe');
  });

  it.each([
    ['revision_conflict', 'workspace.member_role_revision_conflict', 409],
    ['target_inactive', 'workspace.member_role_transition_conflict', 409],
    ['target_missing', 'resource.not_found', 404],
    ['transition_forbidden', 'auth.forbidden', 403],
  ] as const)('maps member-role %s to %s', (reason, code, status) => {
    const error = mapIdentityWorkspaceError(
      new WorkspaceMemberRoleCommandConflictError(reason, 'unsafe detail'),
    );
    expect(error.code).toBe(code);
    expect(APPLICATION_ERROR_CATALOG[error.code].status).toBe(status);
    expect(JSON.stringify(error)).not.toContain('unsafe');
  });

  it('maps a stale member-read authorization to safe forbidden', () => {
    const error = mapIdentityWorkspaceError(
      new WorkspaceAccessDeniedError('unsafe membership detail'),
    );
    expect(error).toEqual({
      code: 'auth.forbidden',
      safeDetail: 'The actor is no longer authorized for this workspace.',
    });
  });

  it('keeps an unverified sign-in email on a safe 400', () => {
    const identityError = new IdentityError('identity.email_unverified');
    const error = mapIdentityWorkspaceError(identityError);

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

  it('maps an invalid session to unauthenticated', () => {
    expect(
      mapIdentityWorkspaceError(new IdentityError('identity.session_invalid')),
    ).toEqual({ code: 'auth.unauthenticated' });
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

  it.each([
    new IdempotencyRequestConflictError(),
    new IdempotencyConflictError(),
  ])(
    'maps a reused idempotency key with changed input to the stable conflict',
    (failure) => {
      const error = mapIdentityWorkspaceError(failure);

      expect(error).toEqual({
        code: 'request.idempotency_conflict',
        safeDetail: 'The idempotency key was already used for another request.',
      });
      expect(APPLICATION_ERROR_CATALOG[error.code].status).toBe(409);
    },
  );

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
