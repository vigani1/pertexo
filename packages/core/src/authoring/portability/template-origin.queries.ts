import { workflowTemplateOriginSchema } from '@pertexo/workflow-model';
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
import {
  workflowAccessible,
  workflowActions,
} from '../../tenant-access/resources/workflows.queries.js';
import { WorkflowTemplateOriginUnavailableError } from '../workflows/errors.js';
import type { PoolClient } from 'pg';
import type { FolderScope } from '../../shared/contract.js';
import type { WorkflowRef } from '../workflows/access.js';
import { workflowProjection } from '../workflows/representation/records.queries.js';

/** One scoped statement keeps summary and immutable origin in the same snapshot. */
export async function readWorkflowWithTemplateOrigin(
  client: PoolClient,
  access: FolderScope,
  workflow: WorkflowRef,
) {
  const { workspaceId, workflowId } = workflow;
  if (!(await workflowAccessible(client, access, workflow))) return null;
  let result;
  try {
    result = await drizzle(client)
      .select({
        workflow: workflowProjection,
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
  } catch (error) {
    // Missing/incompatible storage is unsupported projection, never authoritative null.
    const { code } = postgresFailure(error);
    if (code === '42P01' || code === '42703' || code === '42501')
      throw new WorkflowTemplateOriginUnavailableError();
    throw error;
  }
  const row = result[0];
  if (row === undefined) return null;
  const origin = workflowTemplateOriginSchema
    .nullable()
    .safeParse(row.templateOrigin);
  if (!origin.success) throw new WorkflowTemplateOriginUnavailableError();
  return Object.freeze({
    workflow: {
      ...row.workflow,
      resourceAccess: workflowActions(access, row.folderId),
    },
    templateOrigin: origin.data,
  });
}
