import type { WorkflowAuthoringDatabase } from './workflow-authoring-contracts.js';
import type { WorkflowAuthoringReadContext } from './workflow-authoring-reads.js';
import { WorkflowTemplateOriginUnavailableError } from './workflow-authoring-errors.js';
import { workflowTemplateOriginSchema } from '@pertexo/templates';
import { mapWorkflow } from './workflow-authoring-rows.js';
import { z } from 'zod';

/** One scoped statement keeps summary and immutable origin in the same snapshot. */
export function createWorkflowTemplateOriginReader(
  context: WorkflowAuthoringReadContext,
): WorkflowAuthoringDatabase['getWorkflowWithTemplateOrigin'] {
  return (workspaceId: string, workflowId: string, actorId: string) =>
    context.transact(workspaceId, actorId, async (client) => {
      await context.requireReader(client, workspaceId, actorId);
      const id = z.uuid().parse(workflowId);
      let result;
      try {
        result = await client.query<Record<string, unknown>>(
          `select row_to_json(workflow) workflow, origin.origin template_origin
             from app.workflows workflow
             left join app.workflow_template_origins origin on origin.workspace_id=workflow.workspace_id and origin.workflow_id=workflow.id
             where workflow.workspace_id=$1 and workflow.id=$2`,
          [workspaceId, id],
        );
      } catch (error) {
        // Missing/incompatible storage is unsupported projection, never authoritative null.
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['42P01', '42703', '42501'].includes(String(error.code))
        )
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
        workflow: mapWorkflow(row.workflow as Record<string, unknown>),
        templateOrigin: origin.data,
      });
    });
}
