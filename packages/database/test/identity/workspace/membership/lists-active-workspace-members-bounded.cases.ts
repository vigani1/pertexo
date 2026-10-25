import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';

import { expect, it } from 'vitest';
import {
  WorkspaceAccessDeniedError,
  workspaceMemberships,
} from '../../../../src/testing.js';

import {
  migrationUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
} from '../fixture.js';

export function registerListsActiveWorkspaceMembersBounded(): void {
  it('lists active workspace members with bounded tuple pagination and rechecks member-read authorization', async () => {
    const isolatedWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Member pagination',
      slug: `members-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const members = await Promise.all(
      ['Active A', 'Suspended membership', 'Removed', 'Inactive user'].map(
        (displayName) =>
          identityDatabase.createUser({
            email: `${randomUUID()}@example.test`,
            displayName,
          }),
      ),
    );
    const [active, suspended, removed, inactive] = members;
    if (
      active === undefined ||
      suspended === undefined ||
      removed === undefined ||
      inactive === undefined
    )
      throw new Error('Member fixtures were not created');
    await tenantDatabase.withWorkspace(isolatedWorkspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values([
        {
          workspaceId: isolatedWorkspace.id,
          userId: active.id,
          role: 'viewer',
          status: 'active',
        },
        {
          workspaceId: isolatedWorkspace.id,
          userId: suspended.id,
          role: 'viewer',
          status: 'suspended',
        },
        {
          workspaceId: isolatedWorkspace.id,
          userId: removed.id,
          role: 'viewer',
          status: 'removed',
        },
        {
          workspaceId: isolatedWorkspace.id,
          userId: inactive.id,
          role: 'viewer',
          status: 'active',
        },
      ]);
    });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query(
        `update app.workspace_memberships
         set created_at = case
           when user_id = $2 then '2026-09-13 12:00:00.123455+00'::timestamptz
           when user_id in ($3, $4) then '2026-09-13 12:00:00.123456+00'::timestamptz
           else '2026-09-13 12:00:00.123457+00'::timestamptz
         end
         where workspace_id = $1`,
        [isolatedWorkspace.id, ownerUserId, active.id, suspended.id],
      );
      await owner.query(
        `update app.users set status = 'suspended' where id = $1`,
        [inactive.id],
      );
    } finally {
      await owner.end();
    }

    const traversed: { userId: string; membershipStatus: string }[] = [];
    let cursor: Readonly<{ createdAt: string; userId: string }> | undefined;
    do {
      const page = await identityDatabase.listWorkspaceMembers(
        isolatedWorkspace.id,
        ownerUserId,
        { limit: 1, ...(cursor === undefined ? {} : { after: cursor }) },
      );
      traversed.push(...page.items);
      if (page.nextCursor !== undefined)
        expect(page.nextCursor.createdAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u,
        );
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const tied = [active.id, suspended.id].sort();
    expect(traversed).toEqual([
      expect.objectContaining({
        userId: ownerUserId,
        membershipStatus: 'active',
      }),
      expect.objectContaining({
        userId: tied[0],
        membershipStatus: tied[0] === active.id ? 'active' : 'suspended',
      }),
      expect.objectContaining({
        userId: tied[1],
        membershipStatus: tied[1] === active.id ? 'active' : 'suspended',
      }),
    ]);
    expect(traversed.map((member) => member.userId)).not.toContain(removed.id);
    expect(traversed.map((member) => member.userId)).not.toContain(inactive.id);

    await tenantDatabase.withWorkspace(isolatedWorkspace.id, async ({ db }) => {
      await db
        .update(workspaceMemberships)
        .set({ role: 'viewer' })
        .where(eq(workspaceMemberships.userId, ownerUserId));
    });
    try {
      await expect(
        identityDatabase.listWorkspaceMembers(
          isolatedWorkspace.id,
          ownerUserId,
        ),
      ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    } finally {
      await tenantDatabase.withWorkspace(
        isolatedWorkspace.id,
        async ({ db }) => {
          await db
            .update(workspaceMemberships)
            .set({ role: 'owner' })
            .where(eq(workspaceMemberships.userId, ownerUserId));
        },
      );
    }
  });
}
