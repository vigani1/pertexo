import {
  workflowActions,
  workflowAccessible,
} from '../../tenant-access/resources/workflows.queries.js';
import type { WorkflowAuthoringDatabase } from '../workflows/contract.js';
import type { WorkflowAuthoringReadContext } from '../workflows/reads.queries.js';
import { WorkflowTemplateOriginUnavailableError } from '../workflows/errors.js';
import { workflowTemplateOriginSchema } from '@pertexo/workflow-model';
import {
  mapWorkflow,
  workflowRowSelection,
} from '../workflows/representation/records.queries.js';
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
      const parameters: unknown[] = [workspaceId, id];
      let result;
      try {
        result = await client.query<Record<string, unknown>>(
          `select row_to_json(workflow) workflow, origin.origin template_origin, state.folder_id
             from (select ${workflowRowSelection} from app.workflows) workflow
             left join app.workflow_organization_state state on state.workspace_id=workflow.workspace_id and state.workflow_id=workflow.id
             left join app.workflow_template_origins origin on origin.workspace_id=workflow.workspace_id and origin.workflow_id=workflow.id
             where workflow.workspace_id=$1 and workflow.id=$2`,
          parameters,
        );
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
      const row = result.rows[0];
      if (row === undefined) return null;
      const origin = workflowTemplateOriginSchema
        .nullable()
        .safeParse(row.template_origin);
      if (!origin.success) throw new WorkflowTemplateOriginUnavailableError();
      return Object.freeze({
        workflow: {
          ...mapWorkflow(row.workflow as Record<string, unknown>),
          resourceAccess: workflowActions(
            access,
            z.uuid().nullable().parse(row.folder_id),
          ),
        },
        templateOrigin: origin.data,
      });
    });
}
