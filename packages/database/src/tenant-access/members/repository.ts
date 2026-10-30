import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  users,
  workspaceMemberships,
  workspaces,
} from '../../schema/foundation.js';
import { authDirectoryMemberships } from '../../schema/identity/federation/directory/sources.js';
import { authDirectoryUsers } from '../../schema/identity/federation/directory/users.js';
import { authOrganizations } from '../../schema/identity/federation/organizations.js';

import { rolesForCapability } from '@pertexo/workflow-model';
import type {
  AccessibleWorkspacesPage,
  IdentityWorkspaceDatabase,
  WorkspaceAccessRecord,
  WorkspaceMembersPage,
  WorkspaceStatus,
} from '../contract.js';
import {
  withActorScopedClient,
  withTenantScopedClient,
} from '../transactions.js';
import { lockWorkspaceAuthority } from '../workspaces/authority.queries.js';

type MemberStore = Pick<
  IdentityWorkspaceDatabase,
  'findWorkspaceAccess' | 'listAccessibleWorkspaces' | 'listWorkspaceMembers'
>;

async function listAccessibleWorkspaces(
  pool: Pool,
  actorId: string,
  input: Readonly<{ limit?: number; after?: string }> = {},
): Promise<AccessibleWorkspacesPage> {
  const after = input.after;
  const limit = input.limit ?? 50;
  return withActorScopedClient(pool, actorId, async (client) => {
    const rowsFound = await drizzle(client)
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        // The status predicate excludes purging/deleted workspaces from this page.
        status: sql<
          Extract<WorkspaceStatus, 'active' | 'suspended' | 'pending_deletion'>
        >`${workspaces.status}`,
        revision: workspaces.revision,
        role: workspaceMemberships.role,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaceMemberships)
      .innerJoin(
        workspaces,
        eq(workspaces.id, workspaceMemberships.workspaceId),
      )
      .innerJoin(
        users,
        and(
          eq(users.id, workspaceMemberships.userId),
          eq(users.status, 'active'),
        ),
      )
      .where(
        and(
          eq(workspaceMemberships.userId, actorId),
          eq(workspaceMemberships.status, 'active'),
          inArray(workspaces.status, [
            'active',
            'suspended',
            'pending_deletion',
          ]),
          sql`(${after ?? null}::uuid is null or ${workspaces.id}>${after ?? null}::uuid)`,
        ),
      )
      .orderBy(workspaces.id)
      .limit(limit + 1)
      .catch(rethrowQueryFailure);
    const hasNext = rowsFound.length > limit;
    const rows = hasNext ? rowsFound.slice(0, limit) : rowsFound;
    const items = Object.freeze(rows.map((row) => Object.freeze(row)));
    const last = rows.at(-1);
    return Object.freeze({
      items,
      ...(hasNext && last !== undefined ? { nextCursor: last.id } : {}),
    });
  });
}

async function findWorkspaceAccess(
  pool: Pool,
  actorId: string,
  workspaceId: string,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<WorkspaceAccessRecord | null> {
  return withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      const result = await drizzle(client)
        .select({
          actorId: workspaceMemberships.userId,
          workspaceId: workspaceMemberships.workspaceId,
          role: workspaceMemberships.role,
          membershipStatus: workspaceMemberships.status,
          workspaceStatus: workspaces.status,
        })
        .from(workspaceMemberships)
        .innerJoin(
          workspaces,
          eq(workspaces.id, workspaceMemberships.workspaceId),
        )
        .innerJoin(
          users,
          and(
            eq(users.id, workspaceMemberships.userId),
            eq(users.status, 'active'),
          ),
        )
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.userId, actorId),
          ),
        )
        .catch(rethrowQueryFailure);
      const row = result[0];
      return row === undefined ? null : Object.freeze(row);
    },
    options,
  );
}

async function listWorkspaceMembers(
  pool: Pool,
  workspaceId: string,
  actorId: string,
  input: Readonly<{
    limit?: number;
    after?: Readonly<{ createdAt: string; userId: string }>;
  }> = {},
): Promise<WorkspaceMembersPage> {
  const limit = input.limit ?? 50;
  const afterUserId =
    input.after === undefined ? undefined : input.after.userId;
  const afterCreatedAt =
    input.after === undefined ? undefined : input.after.createdAt;
  return withTenantScopedClient(
    pool,
    { workspaceId, actorId },
    async (client): Promise<WorkspaceMembersPage> => {
      await lockWorkspaceAuthority(
        client,
        workspaceId,
        actorId,
        rolesForCapability('member:read'),
      );
      const db = drizzle(client);
      const directory = db
        .select({
          workspaceId: authDirectoryMemberships.workspaceId,
          userId: authDirectoryMemberships.userId,
          directoryUserId: authDirectoryMemberships.directoryUserId,
          organizationId: authDirectoryMemberships.organizationId,
          directoryRevision: authDirectoryUsers.revision,
          controlWorkspaceId: authOrganizations.controlWorkspaceId,
        })
        .from(authDirectoryMemberships)
        .innerJoin(
          authDirectoryUsers,
          eq(authDirectoryUsers.id, authDirectoryMemberships.directoryUserId),
        )
        .innerJoin(
          authOrganizations,
          eq(authOrganizations.id, authDirectoryMemberships.organizationId),
        )
        .as('directory_source');
      const found = await db
        .select({
          userId: workspaceMemberships.userId,
          email: users.email,
          displayName: users.displayName,
          role: workspaceMemberships.role,
          roleRevision: workspaceMemberships.roleRevision,
          // The page includes only present active/suspended memberships.
          membershipStatus: sql<
            'active' | 'suspended'
          >`${workspaceMemberships.status}`,
          directorySource: {
            directoryUserId: directory.directoryUserId,
            organizationId: directory.organizationId,
            directoryRevision: directory.directoryRevision,
            controlWorkspaceId: directory.controlWorkspaceId,
          },
          createdAt: workspaceMemberships.createdAt,
          updatedAt: workspaceMemberships.updatedAt,
          cursor: sql<string>`to_char(${workspaceMemberships.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(workspaceMemberships)
        .innerJoin(
          users,
          and(
            eq(users.id, workspaceMemberships.userId),
            eq(users.status, 'active'),
          ),
        )
        .leftJoin(
          directory,
          and(
            eq(directory.workspaceId, workspaceMemberships.workspaceId),
            eq(directory.userId, workspaceMemberships.userId),
          ),
        )
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            inArray(workspaceMemberships.status, ['active', 'suspended']),
            sql`(${afterCreatedAt ?? null}::timestamptz is null or (${workspaceMemberships.createdAt}, ${workspaceMemberships.userId})>(${afterCreatedAt ?? null}::timestamptz, ${afterUserId ?? null}::uuid))`,
          ),
        )
        .orderBy(workspaceMemberships.createdAt, workspaceMemberships.userId)
        .limit(limit + 1)
        .catch(rethrowQueryFailure);
      const hasNext = found.length > limit;
      const rows = hasNext ? found.slice(0, limit) : found;
      const last = rows.at(-1);
      const items = Object.freeze(
        rows.map(({ directorySource, cursor: _cursor, ...row }) =>
          Object.freeze({
            ...row,
            ...(directorySource === null ? {} : { directorySource }),
          }),
        ),
      );
      if (!hasNext) return Object.freeze({ items });
      if (last === undefined)
        throw new Error('Workspace member page cursor is unavailable');
      return Object.freeze({
        items,
        nextCursor: Object.freeze({
          createdAt: last.cursor,
          userId: last.userId,
        }),
      });
    },
  );
}

export function createIdentityWorkspaceMemberStore(pool: Pool): MemberStore {
  return Object.freeze({
    listAccessibleWorkspaces: (actorId, input) =>
      listAccessibleWorkspaces(pool, actorId, input),
    findWorkspaceAccess: (actorId, workspaceId, options) =>
      findWorkspaceAccess(pool, actorId, workspaceId, options),
    listWorkspaceMembers: (workspaceId, actorId, input) =>
      listWorkspaceMembers(pool, workspaceId, actorId, input),
  });
}
