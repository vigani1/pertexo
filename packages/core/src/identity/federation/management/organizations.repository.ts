import {
  authOrganizations,
  authOrganizationWorkspaces,
  authDomains,
  authProviders,
} from '@pertexo/database/schema';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { organizationSelection } from './identity-organizations.repository.js';
import type { FederationScope } from './federation-management.types.js';

/** Creates the organization and binds its control workspace to it. */
export async function insertOrganization(
  client: PoolClient,
  scope: FederationScope,
  { id, name }: Readonly<{ id: string; name: string }>,
) {
  const [row] = await drizzle(client)
    .insert(authOrganizations)
    .values({ id, controlWorkspaceId: scope.workspaceId, name })
    .returning(organizationSelection)
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new Error('Organization creation returned no row');
  await withWorkspaceScope(client, scope, async (scoped) => {
    await drizzle(scoped)
      .insert(authOrganizationWorkspaces)
      .values({ workspaceId: scope.workspaceId, organizationId: id })
      .catch(rethrowQueryFailure);
  });
  return row;
}

export async function countOrganizationWorkspaces(
  client: PoolClient,
  organizationId: string,
): Promise<number> {
  const [row] = await drizzle(client)
    .select({ count: count() })
    .from(authOrganizationWorkspaces)
    .where(eq(authOrganizationWorkspaces.organizationId, organizationId))
    .catch(rethrowQueryFailure);
  return row?.count ?? 0;
}

export async function linkWorkspace(
  client: PoolClient,
  link: Readonly<{
    workspaceId: string;
    organizationId: string;
    defaultRole: typeof authOrganizationWorkspaces.$inferInsert.defaultRole;
  }>,
): Promise<void> {
  await drizzle(client)
    .insert(authOrganizationWorkspaces)
    .values(link)
    .onConflictDoUpdate({
      target: authOrganizationWorkspaces.workspaceId,
      set: { defaultRole: link.defaultRole },
    })
    .catch(rethrowQueryFailure);
}

export async function countOrganizationResources(
  client: PoolClient,
  organizationId: string,
  resource: 'domains' | 'providers',
): Promise<number> {
  const table = resource === 'domains' ? authDomains : authProviders;
  const [row] = await drizzle(client)
    .select({ count: count() })
    .from(table)
    .where(eq(table.organizationId, organizationId))
    .catch(rethrowQueryFailure);
  return row?.count ?? 0;
}
