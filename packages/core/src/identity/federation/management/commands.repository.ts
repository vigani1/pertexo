import { authOrganizations } from '@pertexo/database/schema';

import { eq, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { organizationSelection } from './identity-organizations.repository.js';

import type { PoolClient } from 'pg';
import type { OrganizationRow } from './identity-organizations.repository.js';

export async function advanceOrganization(
  client: PoolClient,
  organization: Pick<OrganizationRow, 'id'>,
): Promise<OrganizationRow> {
  const [row] = await drizzle(client)
    .update(authOrganizations)
    .set({ revision: sql`${authOrganizations.revision}+1` })
    .where(eq(authOrganizations.id, organization.id))
    .returning(organizationSelection)
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new Error('Organization disappeared under lock');
  return row;
}
