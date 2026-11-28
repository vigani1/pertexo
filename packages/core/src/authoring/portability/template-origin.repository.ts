import { and, eq } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import {
  postgresFailure,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';

import {
  workflowOrganizationState,
  workflowTemplateOrigins,
  workflows,
} from '@pertexo/database/schema';

import type { PoolClient } from 'pg';

import { workflowReadProjection } from '../workflows/representation/workflow-representations.repository.js';

/**
 * The workflow with its folder and stored origin, undefined when it's gone, or
 * `unavailable` when the origin storage is missing or incompatible: that is an
 * unsupported projection, never an authoritative null.
 */
export async function readTemplateOriginRow(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  try {
    const result = await drizzle(client)
      .select({
        workflow: workflowReadProjection,
        templateOrigin: workflowTemplateOrigins.origin,
        folderId: workflowOrganizationState.folderId,
      })
      .from(workflows)
      .leftJoin(
        workflowOrganizationState,
        and(
          eq(workflowOrganizationState.workspaceId, workflows.workspaceId),
          eq(workflowOrganizationState.workflowId, workflows.id),
        ),
      )
      .leftJoin(
        workflowTemplateOrigins,
        and(
          eq(workflowTemplateOrigins.workspaceId, workflows.workspaceId),
          eq(workflowTemplateOrigins.workflowId, workflows.id),
        ),
      )
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          eq(workflows.id, workflowId),
        ),
      )
      .catch(rethrowQueryFailure);
    return result[0];
  } catch (error) {
    const { code } = postgresFailure(error);
    if (code === '42P01' || code === '42703' || code === '42501')
      return 'unavailable' as const;
    throw error;
  }
}
