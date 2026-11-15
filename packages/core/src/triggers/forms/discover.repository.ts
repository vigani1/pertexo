import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Pool } from 'pg';

/** The form behind a public link and capability digest, if one matches. */
export async function lookupPublicForm(
  pool: Pool,
  publicId: string,
  digest: string,
) {
  const result = await drizzle(pool)
    .execute<{
      workspaceId: string;
      workflowId: string;
      nodeId: string;
      access: string;
      workspaceStatus: string;
    }>(
      sql`select workspace_id "workspaceId",workflow_id "workflowId",node_id "nodeId",access,workspace_status "workspaceStatus" from app.lookup_public_form(${publicId},${digest})`,
    )
    .catch(rethrowQueryFailure);
  return result.rows[0];
}
