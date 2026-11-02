import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { loadBuiltEntry } from '../../support/built-entry.js';

const run = promisify(execFile);

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

it('names the one class a denial is thrown as, wherever it is imported from', async () => {
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const area = await import('@pertexo/core/tenant-access');
       const denial = new area.WorkspaceAccessDeniedError('denied');
       const runs = await import('@pertexo/core/runs');
       process.stdout.write(JSON.stringify({
         instance: denial instanceof area.WorkspaceAccessDeniedError,
         name: denial.constructor.name,
         runsLoaded: Object.keys(runs).length > 0,
       }));`,
    ],
    { cwd: new URL('../../..', import.meta.url), timeout: 60_000 },
  );
  expect(JSON.parse(stdout)).toEqual({
    instance: true,
    name: 'WorkspaceAccessDeniedError',
    runsLoaded: true,
  });
}, 60_000);
