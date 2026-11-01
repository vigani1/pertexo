import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';

import { expect, it } from 'vitest';
import { WorkspaceRenameCommandConflictError } from '../../../../src/testing.js';
import { auditEvents, workspaceMemberships } from '@pertexo/database/testing';

import {
  adminDatabaseUrl,
  migrationUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  workspaceId,
} from '../fixture.js';

export function registerSerializesConcurrentRenamesAuthorizesAgainst(): void {
  it('keeps stored display text normalization from changing rename revisions', async () => {
    const user = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Stored profile',
    });
    const target = await identityDatabase.createWorkspaceWithOwner({
      name: 'Stored workspace',
      slug: `stored-text-${randomUUID().slice(0, 12)}`,
      ownerUserId: user.id,
    });
    const administrator = new Pool({
      connectionString: adminDatabaseUrl,
      max: 1,
    });
    try {
      await administrator.query(
        'update app.users set display_name=$2 where id=$1',
        [user.id, '\t Stored profile \u00a0'],
      );
      await administrator.query(
        'update app.workspaces set name=$2 where id=$1',
        [target.id, '\t Stored workspace \u00a0'],
      );
    } finally {
      await administrator.end();
    }
    await expect(identityDatabase.findUserById(user.id)).resolves.toMatchObject(
      {
        displayName: 'Stored profile',
        createdAt: expect.any(Date) as unknown,
        updatedAt: expect.any(Date) as unknown,
      },
    );
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: user.id,
        name: 'Stored workspace',
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toMatchObject({
      changed: false,
      replayed: false,
      workspace: { name: 'Stored workspace', revision: 1 },
    });
  });

  it('serializes concurrent renames and authorizes against current database state', async () => {
    const target = await identityDatabase.createWorkspaceWithOwner({
      name: 'Concurrent rename target',
      slug: `rename-race-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const outcomes = await Promise.allSettled([
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: ownerUserId,
        name: 'Concurrent left',
        expectedRevision: 1,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: ownerUserId,
        name: 'Concurrent right',
        expectedRevision: 1,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejected?.status !== 'rejected')
      throw new Error('Expected one rejected concurrent rename');
    expect(rejected.reason).toBeInstanceOf(WorkspaceRenameCommandConflictError);
    if (!(rejected.reason instanceof WorkspaceRenameCommandConflictError))
      throw new Error('Expected a workspace rename conflict');
    expect(rejected.reason.reason).toBe('revision_conflict');

    const actor = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Current-state manager',
    });
    const owner = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      await owner.query(
        `insert into app.workspace_memberships
           (workspace_id,user_id,role,status)
         values($1,$2,'admin','active')`,
        [target.id, actor.id],
      );
    } finally {
      await owner.end();
    }
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: actor.id,
        name: 'Admin-authorized name',
        expectedRevision: 2,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
    ).resolves.toMatchObject({
      workspace: { name: 'Admin-authorized name', revision: 3 },
    });
    const demoter = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      await demoter.query(
        `update app.workspace_memberships set role='builder'
         where workspace_id=$1 and user_id=$2`,
        [target.id, actor.id],
      );
    } finally {
      await demoter.end();
    }
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: actor.id,
        name: 'Forbidden builder name',
        expectedRevision: 3,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(WorkspaceRenameCommandConflictError);

    const inactive = await identityDatabase.createWorkspaceWithOwner({
      name: 'Inactive rename target',
      slug: `inactive-rename-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const suspender = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      await suspender.query(
        "update app.workspaces set status='suspended' where id=$1",
        [inactive.id],
      );
    } finally {
      await suspender.end();
    }
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: inactive.id,
        actorUserId: ownerUserId,
        name: 'Forbidden inactive name',
        expectedRevision: 1,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ reason: 'workspace_inactive' });
  });

  it.each(['suspended', 'deleted'] as const)(
    'fails closed across sessions and workspace access when a user is %s',
    async (status) => {
      const user = await identityDatabase.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Status controlled user',
      });
      const workspace = await identityDatabase.createWorkspaceWithOwner({
        name: 'Status controlled workspace',
        slug: `status-${randomUUID().slice(0, 12)}`,
        ownerUserId: user.id,
      });

      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        await owner.query('set role pertexo_owner');
        await owner.query(
          `insert into app.auth_sessions(id,user_id,token,expires_at)
           values($1,$2,$3,clock_timestamp()+interval '1 hour')`,
          [randomUUID(), user.id, randomUUID()],
        );
        await owner.query('update app.users set status = $2 where id = $1', [
          user.id,
          status,
        ]);
        const sessions = await owner.query<{ count: number }>(
          'select count(*)::int count from app.auth_sessions where user_id=$1',
          [user.id],
        );
        expect(sessions.rows).toEqual([{ count: 0 }]);
      } finally {
        await owner.end();
      }

      await expect(
        identityDatabase.findWorkspaceAccess(user.id, workspace.id),
      ).resolves.toBeNull();
    },
  );

  it('creates owner membership and audit atomically under workspace RLS', async () => {
    const rows = await tenantDatabase.withWorkspace(
      workspaceId,
      async ({ db }) => {
        const memberships = await db.select().from(workspaceMemberships);
        const events = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.workspaceId, workspaceId));
        return { memberships, events };
      },
    );
    expect(rows.memberships).toHaveLength(1);
    expect(rows.memberships[0]?.role).toBe('owner');
    expect(rows.events.map((event) => event.action).sort()).toEqual([
      'workspace.created',
      'workspace.member_added',
    ]);
  });

  it('returns only the exact actor/workspace authorization row', async () => {
    await expect(
      identityDatabase.findWorkspaceAccess(ownerUserId, workspaceId),
    ).resolves.toEqual({
      actorId: ownerUserId,
      workspaceId,
      role: 'owner',
      membershipStatus: 'active',
      workspaceStatus: 'active',
    });
    await expect(
      identityDatabase.findWorkspaceAccess(randomUUID(), workspaceId),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.findWorkspaceAccess(ownerUserId, randomUUID()),
    ).resolves.toBeNull();
  });
}
