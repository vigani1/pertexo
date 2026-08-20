import {
  IdentityConflictError,
  WorkspaceLifecycleConflictError,
} from '@pertexo/database';
import { describe, expect, it } from 'vitest';

import { APPLICATION_ERROR_CATALOG } from '../../src/platform/http/index.js';
import { mapIdentityWorkspaceError } from '../../src/identity-workspace/index.js';

describe('identity/workspace conflict mapping', () => {
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
