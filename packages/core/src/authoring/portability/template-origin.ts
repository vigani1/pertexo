import type { WorkflowRef } from '../../shared/access/workflow-actor.types.js';

import { workflowTemplateOriginSchema } from '@pertexo/workflow-model';

import {
  workflowAccessible,
  workflowActions,
} from '../../shared/resources/workflow-access.repository.js';

import { WorkflowTemplateOriginUnavailableError } from '../workflows/workflow-authoring.errors.js';

import type { PoolClient } from 'pg';

import type { FolderScope } from '../../shared/access/folder-access.types.js';

import { readTemplateOriginRow } from './template-origin.repository.js';

/** One scoped statement keeps summary and immutable origin in the same snapshot. */
export async function readWorkflowWithTemplateOrigin(
  client: PoolClient,
  access: FolderScope,
  workflow: WorkflowRef,
) {
  const { workspaceId, workflowId } = workflow;
  if (!(await workflowAccessible(client, access, workflow))) return null;
  const read = await readTemplateOriginRow(client, workspaceId, workflowId);
  if (read === 'unavailable')
    throw new WorkflowTemplateOriginUnavailableError();
  const row = read;
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
