import { authOrganizationWorkspaces } from '@pertexo/database/schema';

import { and, eq } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

export async function deleteWorkspaceLink(
  client: PoolClient,
  organizationId: string,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .delete(authOrganizationWorkspaces)
    .where(
      and(
        eq(authOrganizationWorkspaces.organizationId, organizationId),
        eq(authOrganizationWorkspaces.workspaceId, workspaceId),
      ),
    )
    .catch(rethrowQueryFailure);
}
