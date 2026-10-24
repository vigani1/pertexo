import { randomUUID } from 'node:crypto';
import type { createIdentityWorkspaceDatabase } from '../../src/tenant-access/database.js';

type Identity = Pick<
  ReturnType<typeof createIdentityWorkspaceDatabase>,
  'createUser'
>;

export function createTestUser(identity: Identity, displayName: string) {
  return identity.createUser({
    email: `${randomUUID()}@example.test`,
    displayName,
  });
}
