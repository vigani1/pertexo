import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '../../schema/authoring/workflows.js';
import { workflowOrganizationState } from '../../schema/authoring/organization.js';
import { workflowTemplateOrigins } from '../../schema/authoring/template-origin.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  workflowActions,
  workflowAccessible,
} from '../../tenant-access/resources/workflows.queries.js';
import type { WorkflowAuthoringDatabase } from '../workflows/contract.js';
import type { WorkflowAuthoringReadContext } from '../workflows/reads.queries.js';
import { WorkflowTemplateOriginUnavailableError } from '../workflows/errors.js';
import { workflowTemplateOriginSchema } from '@pertexo/workflow-model';
import { workflowProjection } from '../workflows/representation/records.queries.js';
import { z } from 'zod';

/** One scoped statement keeps summary and immutable origin in the same snapshot. */
export function createWorkflowTemplateOriginReader(
  context: WorkflowAuthoringReadContext,
): WorkflowAuthoringDatabase['getWorkflowWithTemplateOrigin'] {
  return (workspaceId: string, workflowId: string, actorId: string) =>
    context.transact(workspaceId, actorId, async (client) => {
      const access = await context.requireReader(client, workspaceId, actorId);
      if (
        !(await workflowAccessible(client, access, {
          workspaceId,
          workflowId,
        }))
      )
        return null;
      const id = z.uuid().parse(workflowId);
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
            and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, id)),
          )
          .catch(rethrowQueryFailure);
      } catch (error) {
        // Missing/incompatible storage is unsupported projection, never authoritative null.
        const originStorageUnavailable =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['42P01', '42703', '42501'].includes(String(error.code));
        if (originStorageUnavailable)
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
    });
}
