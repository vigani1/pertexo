import { publicFormIsAvailable } from './public-form-standing.js';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Pool } from 'pg';

import { capabilityHash } from './access.repository.js';
import type {
  DiscoverFormInput,
  PublicFormGrant,
} from './form-admission.types.js';
import { FormUnavailableError } from './form.errors.js';

/** No member behind this one either: it turns a link into a grant. */
export async function discoverPublicForm(
  pool: Pool,
  input: DiscoverFormInput,
): Promise<PublicFormGrant> {
  const digest = capabilityHash(input.capability);
  const result = await drizzle(pool)
    .execute<{
      workspaceId: string;
      workflowId: string;
      nodeId: string;
      access: string;
      workspaceStatus: string;
    }>(
      sql`select workspace_id "workspaceId",workflow_id "workflowId",node_id "nodeId",access,workspace_status "workspaceStatus" from app.lookup_public_form(${input.publicId},${digest})`,
    )
    .catch(rethrowQueryFailure);
  const row = result.rows[0];
  if (row === undefined || !publicFormIsAvailable(row))
    throw new FormUnavailableError();
  return {
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    nodeId: row.nodeId,
    publicId: input.publicId,
    capabilityHash: digest,
  };
}
