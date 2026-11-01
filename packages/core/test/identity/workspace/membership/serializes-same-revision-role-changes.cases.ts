import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';

import { expect, it } from 'vitest';
import type { WorkspaceMemberRoleCommandConflictError } from '../../../../src/testing.js';
import { workspaceMemberships } from '@pertexo/database/testing';

import {
  migrationUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
} from '../fixture.js';

export function registerSerializesSameRevisionRoleChanges(): void {
  it('serializes same-revision role changes and rejects stale and forbidden transitions', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role concurrency',
      slug: `role-concurrency-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const [target, admin] = await Promise.all([
      identityDatabase.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Target',
      }),
      identityDatabase.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Admin',
      }),
    ]);
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values([
        {
          workspaceId: commandWorkspace.id,
          userId: target.id,
          role: 'viewer',
          status: 'active',
        },
        {
          workspaceId: commandWorkspace.id,
          userId: admin.id,
          role: 'admin',
          status: 'active',
        },
      ]);
    });
    const results = await Promise.allSettled([
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: 'builder',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: 'operator',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status !== 'rejected')
      throw new Error('A concurrent role command should have failed');
    expect(
      (rejected.reason as WorkspaceMemberRoleCommandConflictError).reason,
    ).toBe('revision_conflict');
    const afterConcurrent = (
      await identityDatabase.listWorkspaceMembers(
        commandWorkspace.id,
        ownerUserId,
      )
    ).items.find((member) => member.userId === target.id);
    if (afterConcurrent === undefined)
      throw new Error('Concurrent target member is unavailable');
    if (afterConcurrent.role === 'owner')
      throw new Error('Concurrent target unexpectedly became owner');
    const alternateRole =
      afterConcurrent.role === 'builder' ? 'operator' : 'builder';
    await identityDatabase.changeWorkspaceMemberRole({
      workspaceId: commandWorkspace.id,
      actorUserId: ownerUserId,
      targetUserId: target.id,
      role: alternateRole,
      expectedRoleRevision: afterConcurrent.roleRevision,
      idempotencyKey: randomUUID(),
    });
    await identityDatabase.changeWorkspaceMemberRole({
      workspaceId: commandWorkspace.id,
      actorUserId: ownerUserId,
      targetUserId: target.id,
      role: afterConcurrent.role,
      expectedRoleRevision: afterConcurrent.roleRevision + 1,
      idempotencyKey: randomUUID(),
    });
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: alternateRole,
        expectedRoleRevision: afterConcurrent.roleRevision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'revision_conflict' });
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: randomUUID(),
        role: 'viewer',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'target_missing' });
    for (const status of ['suspended', 'removed'] as const) {
      await tenantDatabase.withWorkspace(
        commandWorkspace.id,
        async ({ db }) => {
          await db
            .update(workspaceMemberships)
            .set({ status })
            .where(eq(workspaceMemberships.userId, target.id));
        },
      );
      await expect(
        identityDatabase.changeWorkspaceMemberRole({
          workspaceId: commandWorkspace.id,
          actorUserId: ownerUserId,
          targetUserId: target.id,
          role: alternateRole,
          expectedRoleRevision: afterConcurrent.roleRevision + 2,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ reason: 'target_inactive' });
    }
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db
        .update(workspaceMemberships)
        .set({ status: 'active' })
        .where(eq(workspaceMemberships.userId, target.id));
    });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query(`update app.users set status='suspended' where id=$1`, [
        target.id,
      ]);
      await expect(
        identityDatabase.changeWorkspaceMemberRole({
          workspaceId: commandWorkspace.id,
          actorUserId: ownerUserId,
          targetUserId: target.id,
          role: alternateRole,
          expectedRoleRevision: afterConcurrent.roleRevision + 2,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ reason: 'target_inactive' });
    } finally {
      await owner.end();
    }
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: admin.id,
        targetUserId: ownerUserId,
        role: 'viewer',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'owner_change' });
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: admin.id,
        targetUserId: admin.id,
        role: 'viewer',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'self_change' });
  });
}
