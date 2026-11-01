import { waitForBlockedBy } from '../../../support/postgres/lock-coordination.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';

import { expect, it } from 'vitest';
import { auditEvents, workspaceMemberships } from '@pertexo/database/testing';

import {
  migrationUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  createAuthenticationSession,
  findActiveAuthenticationSession,
} from '../fixture.js';

export function registerRollsBackRoleSessionAudit(): void {
  it('rolls back role, session, audit, and receipt writes when a late audit insert fails', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role rollback',
      slug: `role-rollback-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const target = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Rollback target',
    });
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values({
        workspaceId: commandWorkspace.id,
        userId: target.id,
        role: 'viewer',
        status: 'active',
      });
    });
    const digest = await createAuthenticationSession(target.id);
    const idempotencyKey = randomUUID();
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: 'builder',
        expectedRoleRevision: 1,
        idempotencyKey,
        requestId: 'x'.repeat(129),
      }),
    ).rejects.toMatchObject({ code: '22001' });
    const unchanged = await identityDatabase.listWorkspaceMembers(
      commandWorkspace.id,
      ownerUserId,
    );
    expect(
      unchanged.items.find((member) => member.userId === target.id),
    ).toMatchObject({
      role: 'viewer',
      roleRevision: 1,
    });
    await expect(
      findActiveAuthenticationSession(digest),
    ).resolves.toMatchObject({ user_id: target.id });
    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: 'builder',
        expectedRoleRevision: 1,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ changed: true, replayed: false });
  });

  it('coalesces concurrent duplicate role commands into one durable side effect', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role duplicate',
      slug: `role-duplicate-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const target = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Duplicate target',
    });
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values({
        workspaceId: commandWorkspace.id,
        userId: target.id,
        role: 'viewer',
        status: 'active',
      });
    });
    const command = {
      workspaceId: commandWorkspace.id,
      actorUserId: ownerUserId,
      targetUserId: target.id,
      role: 'operator' as const,
      expectedRoleRevision: 1,
      idempotencyKey: randomUUID(),
    };
    const receipts = await Promise.all([
      identityDatabase.changeWorkspaceMemberRole(command),
      identityDatabase.changeWorkspaceMemberRole(command),
    ]);
    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([
      false,
      true,
    ]);
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
    ).toHaveLength(1);
  });

  it('serializes a manager demotion ahead of the manager’s queued command', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Manager demotion',
      slug: `manager-demotion-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const [manager, target] = await Promise.all([
      identityDatabase.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Manager',
      }),
      identityDatabase.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Managed target',
      }),
    ]);
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values([
        {
          workspaceId: commandWorkspace.id,
          userId: manager.id,
          role: 'admin',
          status: 'active',
        },
        {
          workspaceId: commandWorkspace.id,
          userId: target.id,
          role: 'viewer',
          status: 'active',
        },
      ]);
    });
    const blockerPool = new Pool({ connectionString: migrationUrl, max: 2 });
    const blocker = await blockerPool.connect();
    let demotion: Promise<unknown> | undefined;
    let staleManagerCommand: Promise<unknown> | undefined;
    try {
      await blocker.query('begin');
      const holding = await blocker.query<{ pid: number }>(
        'select pg_backend_pid() pid',
      );
      const blockerPid = holding.rows[0]?.pid;
      if (blockerPid === undefined)
        throw new Error('Membership lock holder is missing');
      await blocker.query('set local role pertexo_owner');
      await blocker.query(
        'select id from app.workspaces where id=$1 for update',
        [commandWorkspace.id],
      );
      demotion = identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: manager.id,
        role: 'viewer',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      void demotion.catch(() => undefined);
      await waitForBlockedBy(blockerPool, blockerPid);
      staleManagerCommand = identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: manager.id,
        targetUserId: target.id,
        role: 'operator',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      void staleManagerCommand.catch(() => undefined);
      await waitForBlockedBy(blockerPool, blockerPid, { minimumWaiters: 2 });
      await blocker.query('commit');
      await expect(demotion).resolves.toMatchObject({ role: 'viewer' });
      await expect(staleManagerCommand).rejects.toMatchObject({
        reason: 'actor_inactive',
      });
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await blockerPool.end();
    }
  }, 15_000);
}
