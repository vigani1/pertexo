import { describe, expect, it } from 'vitest';

import { organizationIdentity } from '../../../src/authentication/federation/protocol/identity.js';
import { parseDirectoryUser } from '../../../src/authentication/federation/provisioning/protocol/scim-resources.js';
import {
  applyDirectoryPatch,
  parseDirectoryPatch,
} from '../../../src/authentication/federation/provisioning/protocol/scim-patch.js';

// An address stored before the 254-character bound on new addresses: the
// users and directory columns allow 320, so such rows may exist.
const stored = `${'a'.repeat(64)}@${['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63)].join('.')}.example`;

const directoryUser = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  id: '11111111-1111-4111-8111-111111111111',
  userName: stored,
  active: true,
  emails: [{ value: stored, primary: true }],
  groups: [],
  meta: {
    resourceType: 'User',
    created: '2026-10-18T00:00:00.000Z',
    lastModified: '2026-10-18T00:00:00.000Z',
    version: 'opaque',
  },
};

describe('an existing account with a stored address longer than 254 characters', () => {
  it('is 264 characters long', () => {
    expect(stored).toHaveLength(264);
  });

  it('can be deactivated by its directory, as a PATCH re-parses the stored user', () => {
    const deactivated = parseDirectoryUser(
      applyDirectoryPatch(
        directoryUser,
        parseDirectoryPatch(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'active', value: false }],
          },
          'User',
        ),
      ),
    );
    expect(deactivated.active).toBe(false);
    expect(deactivated.userName).toBe(stored);
  });

  it('is matched on organization sign-in', () => {
    expect(organizationIdentity('subject-1', stored, 'Ada')).toMatchObject({
      email: stored,
    });
  });
});
