import { expect, it } from 'vitest';

import { loadBuiltEntry } from '../support/built-entry.js';

it('loads @pertexo/core/identity as a built package with what its callers use', async () => {
  const names = await loadBuiltEntry('@pertexo/core/identity');
  expect(names).toEqual(
    expect.arrayContaining([
      'AccountLinkingCommands',
      'DirectoryError',
      'EmailProofCommands',
      'FederationConflictError',
      'OrganizationSignInCommands',
      'SocialSignInCommands',
      'createFederationManagementStore',
      'isAuthenticationSessionAllowed',
    ]),
  );
}, 60_000);
