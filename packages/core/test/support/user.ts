import { randomUUID } from 'node:crypto';
import type { Role } from '@pertexo/workflow-model';
import type { createIdentityWorkspaceDatabase } from '../../src/tenant-access/store.js';

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

export async function insertTestMember(
  query: (text: string, values: unknown[]) => Promise<unknown>,
  member: Readonly<{
    userId: string;
    workspaceId: string;
    displayName: string;
    role: Role;
  }>,
): Promise<void> {
  await query(
    `insert into app.users (id,email,display_name,status)
     values ($1,$2,$3,'active')`,
    [member.userId, `${member.userId}@example.test`, member.displayName],
  );
  await query(
    `insert into app.workspace_memberships (workspace_id,user_id,role,status)
     values ($1,$2,$3,'active')`,
    [member.workspaceId, member.userId, member.role],
  );
}
