import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { expect, it } from 'vitest';
import { auditEvents, workspaceMemberships } from '@pertexo/database/testing';

import { IdempotencyConflictError } from '@pertexo/database/platform';

import {
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  createAuthenticationSession,
  findActiveAuthenticationSession,
} from '../fixture.js';

export function registerChangesExistingMemberRoleOnce(): void {
  it('changes an existing member role once, revokes sessions, and replays without reapplying', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role command',
      slug: `role-command-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const target = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Role target',
    });
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values({
        workspaceId: commandWorkspace.id,
        userId: target.id,
        role: 'viewer',
        status: 'active',
      });
    });
    const targetSession = await createAuthenticationSession(target.id);
    const original = {
      workspaceId: commandWorkspace.id,
      actorUserId: ownerUserId,
      targetUserId: target.id,
      role: 'builder' as const,
      expectedRoleRevision: 1,
      idempotencyKey: `role-${randomUUID()}`,
      requestId: 'role-request',
      traceId: 'role-trace',
    };
    await expect(
      identityDatabase.changeWorkspaceMemberRole(original),
    ).resolves.toEqual({
      userId: target.id,
      role: 'builder',
      roleRevision: 2,
      changed: true,
      replayed: false,
    });
    await expect(
      findActiveAuthenticationSession(targetSession),
    ).resolves.toBeNull();

    await identityDatabase.changeWorkspaceMemberRole({
      ...original,
      role: 'operator',
      expectedRoleRevision: 2,
      idempotencyKey: `role-${randomUUID()}`,
    });
    await expect(
      identityDatabase.changeWorkspaceMemberRole(original),
    ).resolves.toMatchObject({
      role: 'builder',
      roleRevision: 2,
      replayed: true,
    });
    const noOpDigest = await createAuthenticationSession(target.id);
    const noOpKey = `role-${randomUUID()}`;
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        ...original,
        role: 'operator',
        expectedRoleRevision: 3,
        idempotencyKey: noOpKey,
      }),
    ).resolves.toMatchObject({
      role: 'operator',
      roleRevision: 3,
      changed: false,
      replayed: false,
    });
    await expect(
      findActiveAuthenticationSession(noOpDigest),
    ).resolves.toMatchObject({ user_id: target.id });
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        ...original,
        role: 'viewer',
        expectedRoleRevision: 3,
        idempotencyKey: noOpKey,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const rows = await identityDatabase.listWorkspaceMembers(
      commandWorkspace.id,
      ownerUserId,
    );
    expect(
      rows.items.find((member) => member.userId === target.id),
    ).toMatchObject({
      role: 'operator',
      roleRevision: 3,
    });
    const facts = await tenantDatabase.withWorkspace(
      commandWorkspace.id,
      async ({ db }) =>
        db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.workspaceId, commandWorkspace.id)),
    );
    expect(
      facts.filter((event) => event.action === 'workspace.member_role_changed'),
    ).toHaveLength(2);
  });
}
