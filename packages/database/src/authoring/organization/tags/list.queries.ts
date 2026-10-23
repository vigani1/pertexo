import { z } from 'zod';

import { ROLES } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';
import { WorkflowNotFoundError } from '../../workflows/errors.js';

import type { createOrganizationSession } from '../session.js';
import { type WorkflowTagDatabase, uuid, tag, assignment } from './contract.js';
import { page, pagination } from './state.queries.js';
import { ADMINISTRATORS } from './commands/receipts.js';

export async function listTags(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['listTags']>[0],
): ReturnType<WorkflowTagDatabase['listTags']> {
  const { limit, after } = page(input);
  return session.transact(input, async (client, scope) => {
    await lockWorkflowAuthoringAuthority(
      client,
      scope.workspaceId,
      scope.actorId,
      ROLES,
    );
    const rows = await client.query<{ tag: unknown }>(
      `select jsonb_build_object('id',id,'key',key,'revision',revision) tag from app.workflow_tags where workspace_id=$1 ${after === null ? '' : 'and id>$2::uuid'} order by id asc limit ${after === null ? '$2' : '$3'}`,
      after === null
        ? [scope.workspaceId, limit + 1]
        : [scope.workspaceId, after, limit + 1],
    );
    return pagination(
      rows.rows.map((row) => tag.parse(row.tag)),
      limit,
      (item) => item.id,
    );
  });
}

export async function listTagAssignments(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['listTagAssignments']>[0],
): ReturnType<WorkflowTagDatabase['listTagAssignments']> {
  const { limit, after } = page(input),
    tagId = uuid.parse(input.tagId);
  return session.transact(input, async (client, scope) => {
    await lockWorkflowAuthoringAuthority(
      client,
      scope.workspaceId,
      scope.actorId,
      ADMINISTRATORS,
    );
    // Tag visibility and the assignment page share one statement snapshot.
    const result = await client.query<{ visible: boolean; items: unknown }>(
      `select exists(select 1 from app.workflow_tags where workspace_id=$1 and id=$2) visible,
          coalesce((select jsonb_agg(page.item order by page.workflow_id) from (
          select a.workflow_id,jsonb_build_object('workflowId',a.workflow_id,'organizationRevision',coalesce(s.revision,1)) item
          from app.workflow_tag_assignments a join app.workflows w on w.workspace_id=a.workspace_id and w.id=a.workflow_id
          left join app.workflow_organization_state s on s.workspace_id=a.workspace_id and s.workflow_id=a.workflow_id
          where a.workspace_id=$1 and a.tag_id=$2 ${after === null ? '' : 'and a.workflow_id>$3::uuid'}
          order by a.workflow_id asc limit ${after === null ? '$3' : '$4'}) page),'[]'::jsonb) items`,
      after === null
        ? [scope.workspaceId, tagId, limit + 1]
        : [scope.workspaceId, tagId, after, limit + 1],
    );
    const row = result.rows[0];
    if (row?.visible !== true)
      throw new WorkflowNotFoundError('Workflow is not visible');
    return pagination(
      z
        .array(assignment)
        .max(limit + 1)
        .parse(row.items),
      limit,
      (item) => item.workflowId,
    );
  });
}
