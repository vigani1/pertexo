import { waitForBlockedBy } from '../../../support/postgres/lock-coordination.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';

import { expect, it } from 'vitest';
import { IdempotencyRequestConflictError } from '../../../../src/testing.js';
import { auditEvents, workspaceMemberships } from '@pertexo/database/testing';

import {
  migrationUrl,
  apiUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  workspaceId,
  pgCode,
} from '../fixture.js';

export function registerSerializesRoleChangeBehindDeletion(): void {
  it('serializes a role change behind a deletion request', async () => {
    const commandWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role lifecycle lock',
      slug: `role-lifecycle-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const target = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Lifecycle target',
    });
    await tenantDatabase.withWorkspace(commandWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values({
        workspaceId: commandWorkspace.id,
        userId: target.id,
        role: 'viewer',
        status: 'active',
      });
    });
    const blockerPool = new Pool({ connectionString: migrationUrl, max: 2 });
    const blocker = await blockerPool.connect();
    let lifecycle: Promise<unknown> | undefined;
    let roleChange: Promise<unknown> | undefined;
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
      lifecycle = identityDatabase.requestWorkspaceLifecycleOperation({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        commandType: 'deletion_requested',
        reason: 'Concurrency proof',
        idempotencyKey: randomUUID(),
      });
      void lifecycle.catch(() => undefined);
      await waitForBlockedBy(blockerPool, blockerPid);
      roleChange = identityDatabase.changeWorkspaceMemberRole({
        workspaceId: commandWorkspace.id,
        actorUserId: ownerUserId,
        targetUserId: target.id,
        role: 'builder',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      void roleChange.catch(() => undefined);
      await waitForBlockedBy(blockerPool, blockerPid, { minimumWaiters: 2 });
      await blocker.query('commit');
      await expect(lifecycle).resolves.toMatchObject({
        commandType: 'deletion_requested',
      });
      // Deletion takes effect first, so the role change finds the workspace
      // no longer active.
      await expect(roleChange).rejects.toMatchObject({
        message: 'The workspace is not active',
      });
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await blockerPool.end();
    }
  }, 15_000);

  it('provides a valid ordered index for non-removed member discovery', async () => {
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const result = await pool.query<{
        valid: boolean;
        definition: string;
        predicate: string;
      }>(
        `select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition,
                pg_get_expr(i.indpred, i.indrelid) as predicate
         from pg_index i
         where i.indexrelid = 'app.workspace_memberships_workspace_created_idx'::regclass`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.valid).toBe(true);
      expect(result.rows[0]?.definition).toContain(
        '(workspace_id, created_at, user_id)',
      );
      expect(result.rows[0]?.predicate).toContain('active');
      expect(result.rows[0]?.predicate).toContain('suspended');
      expect(result.rows[0]?.predicate).not.toContain('removed');
    } finally {
      await pool.end();
    }
  });

  it('fails closed without context and prevents cross-workspace reads', async () => {
    const secondUser = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Second Owner',
    });
    const second = await identityDatabase.createWorkspaceWithOwner({
      name: 'Second Workspace',
      slug: `second-${randomUUID().slice(0, 12)}`,
      ownerUserId: secondUser.id,
    });
    const crossRead = await tenantDatabase.withWorkspace(
      workspaceId,
      async ({ db }) => {
        const memberships = await db
          .select()
          .from(workspaceMemberships)
          .where(eq(workspaceMemberships.workspaceId, second.id));
        const events = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.workspaceId, second.id));
        return { memberships, events };
      },
    );
    expect(crossRead.memberships).toEqual([]);
    expect(crossRead.events).toEqual([]);

    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const result = await pool.query('select * from app.audit_events');
      expect(result.rows).toEqual([]);
      const memberships = await pool.query(
        'select * from app.workspace_memberships',
      );
      expect(memberships.rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('applies one deletion request once', async () => {
    const workspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Lifecycle workspace',
      slug: `lifecycle-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const deletionKey = `delete-${randomUUID()}`;
    const deletionCommand = () =>
      identityDatabase.requestWorkspaceLifecycleOperation({
        workspaceId: workspace.id,
        actorUserId: ownerUserId,
        commandType: 'deletion_requested',
        reason: 'idempotent deletion',
        idempotencyKey: deletionKey,
      });
    const [deletedLeft, deletedRight] = await Promise.all([
      deletionCommand(),
      deletionCommand(),
    ]);
    expect(deletedRight).toEqual(deletedLeft);
    expect(deletedLeft).toMatchObject({
      workspaceId: workspace.id,
      commandType: 'deletion_requested',
    });
    await expect(
      identityDatabase.findWorkspaceAccess(ownerUserId, workspace.id),
    ).resolves.toMatchObject({ workspaceStatus: 'pending_deletion' });
    await expect(
      identityDatabase.requestWorkspaceLifecycleOperation({
        workspaceId: workspace.id,
        actorUserId: ownerUserId,
        commandType: 'deletion_requested',
        reason: 'changed deletion request',
        idempotencyKey: deletionKey,
      }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
  });

  it('denies audit updates and deletes to the API runtime role', async () => {
    await expect(
      tenantDatabase.withWorkspace(workspaceId, async ({ db }) =>
        db
          .update(auditEvents)
          .set({ action: 'tampered' })
          .where(eq(auditEvents.workspaceId, workspaceId)),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      tenantDatabase.withWorkspace(workspaceId, async ({ db }) =>
        db.delete(auditEvents).where(eq(auditEvents.workspaceId, workspaceId)),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });
}
