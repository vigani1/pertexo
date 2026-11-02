import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type {
  SharingPrincipalsQuery,
  SharingPrincipals,
} from '@pertexo/contracts';
import {
  users,
  workspaceMemberships,
  authOrganizationWorkspaces,
  authDirectoryGroups,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { lockBrowsableWorkspaceAuthority } from '../../shared/authority.queries.js';
import { RESOURCE_ADMINISTRATORS } from '../../shared/folder-policy.js';
import type { ResourceActor } from '../../shared/contract.js';

/** Principal discovery is bounded and anchored to this workspace's current identities. */
export async function readSharingPrincipals(
  client: PoolClient,
  actor: ResourceActor,
  input: SharingPrincipalsQuery,
): Promise<SharingPrincipals> {
  await lockBrowsableWorkspaceAuthority(
    client,
    actor.workspaceId,
    actor.actorId,
    RESOURCE_ADMINISTRATORS,
  );
  const db = drizzle(client);
  const search = input.search ?? null;
  const after = input.after ?? null;
  if (input.kind === 'member') {
    const rows = await db
      .select({
        id: users.id,
        label: users.displayName,
        email: users.email,
        role: workspaceMemberships.role,
      })
      .from(workspaceMemberships)
      .innerJoin(
        users,
        and(
          eq(users.id, workspaceMemberships.userId),
          eq(users.status, 'active'),
        ),
      )
      .where(
        and(
          eq(workspaceMemberships.workspaceId, actor.workspaceId),
          eq(workspaceMemberships.status, 'active'),
          sql`(${search}::text is null or position(lower(${search}) in lower(${users.displayName}))>0 or position(lower(${search}) in lower(${users.email}))>0)`,
          sql`(${after}::uuid is null or ${users.id}>${after})`,
        ),
      )
      .orderBy(users.id)
      .limit(input.limit + 1)
      .catch(rethrowQueryFailure);
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((row) => ({
        kind: 'member',
        userId: row.id,
        label: row.label,
        email: row.email,
        role: row.role,
      })),
      next: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
  const rows = await db
    .select({
      id: authDirectoryGroups.id,
      label: authDirectoryGroups.displayName,
      organizationId: authDirectoryGroups.organizationId,
    })
    .from(authOrganizationWorkspaces)
    .innerJoin(
      authDirectoryGroups,
      eq(
        authDirectoryGroups.organizationId,
        authOrganizationWorkspaces.organizationId,
      ),
    )
    .where(
      and(
        eq(authOrganizationWorkspaces.workspaceId, actor.workspaceId),
        sql`(${search}::text is null or position(lower(${search}) in lower(${authDirectoryGroups.displayName}))>0)`,
        sql`(${after}::uuid is null or ${authDirectoryGroups.id}>${after})`,
      ),
    )
    .orderBy(authDirectoryGroups.id)
    .limit(input.limit + 1)
    .catch(rethrowQueryFailure);
  const page = rows.slice(0, input.limit);
  return {
    items: page.map((row) => ({
      kind: 'group',
      organizationId: row.organizationId,
      groupId: row.id,
      label: row.label,
    })),
    next: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
