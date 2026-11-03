import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Pool } from 'pg';

import { capabilityHash } from './access.repository.js';
import type { DiscoverFormInput, PublicFormGrant } from './contract.js';
import { FormUnavailableError } from './errors.js';

/** No member behind this one either: it turns a link into a grant. */
export async function discoverPublicForm(
  pool: Pool,
  input: DiscoverFormInput,
): Promise<PublicFormGrant> {
  const result = await drizzle(pool)
    .execute<{
      workspaceId: string;
      workflowId: string;
      nodeId: string;
    }>(
      sql`select workspace_id "workspaceId",workflow_id "workflowId",node_id "nodeId" from app.lookup_public_form(${input.publicId},${capabilityHash(input.capability)})`,
    )
    .catch(rethrowQueryFailure);
  const row = result.rows[0];
  if (row === undefined) throw new FormUnavailableError();
  return {
    ...row,
    publicId: input.publicId,
    capabilityHash: capabilityHash(input.capability),
  };
}
