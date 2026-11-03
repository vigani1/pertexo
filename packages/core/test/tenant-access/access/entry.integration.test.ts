import { expect, it } from 'vitest';

import { loadBuiltEntry } from '../../support/built-entry.js';

it('loads @pertexo/core/tenant-access as a built package with what its callers use', async () => {
  expect(await loadBuiltEntry('@pertexo/core/tenant-access')).toEqual(
    expect.arrayContaining([
      'ApiTokenPolicyError',
      'WorkspaceAccessDeniedError',
      'WorkspaceInvitationCommandConflictError',
      'WorkspaceRenameCommandConflictError',
      'createApiTokenStore',
      'createIdentityWorkspaceStore',
      'parseApiTokenCredential',
    ]),
  );
}, 60_000);
