import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import {
  workflowOrganizationState,
  workflowTagAssignments,
  workflowTags,
} from '../../../schema/authoring/organization.js';
import { workflows } from '../../../schema/authoring/workflows.js';

import { ROLES } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';
import { WorkflowNotFoundError } from '../../workflows/errors.js';

import type { createOrganizationSession } from '../session.js';
import { ADMINISTRATORS } from './commands/receipts.js';
import type { WorkflowTagDatabase } from './contract.js';
import { page, pagination, tagProjection } from './state.queries.js';

export async function listTags(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['listTags']>[0],
): ReturnType<WorkflowTagDatabase['listTags']> {
  const { limit, after } = page(input);
  return session.transact(input, async (client, scope) => {
    await lockWorkflowAuthoringAuthority(client, scope.workspaceId, {
      actorId: scope.actorId,
      roles: ROLES,
    });
    const rows = await drizzle(client)
      .select(tagProjection)
      .from(workflowTags)
      .where(
        and(
          eq(workflowTags.workspaceId, scope.workspaceId),
          after === null ? undefined : gt(workflowTags.id, after),
        ),
      )
      .orderBy(asc(workflowTags.id))
      .limit(limit + 1)
      .catch(rethrowQueryFailure);
    return pagination(rows, limit, (item) => item.id);
  });
}

export async function listTagAssignments(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['listTagAssignments']>[0],
): ReturnType<WorkflowTagDatabase['listTagAssignments']> {
  const { limit, after } = page(input),
    tagId = input.tagId;
  return session.transact(input, async (client, scope) => {
    await lockWorkflowAuthoringAuthority(client, scope.workspaceId, {
      actorId: scope.actorId,
      roles: ADMINISTRATORS,
    });
    // Tag visibility and the assignment page share one statement snapshot.
    const db = drizzle(client);
    const page = db
      .select({
        workflowId: workflowTagAssignments.workflowId,
        organizationRevision:
          sql<number>`coalesce(${workflowOrganizationState.revision},1)`
            .mapWith(workflowOrganizationState.revision)
            .as('organization_revision'),
      })
      .from(workflowTagAssignments)
      .innerJoin(
        workflows,
        and(
          eq(workflows.workspaceId, workflowTagAssignments.workspaceId),
          eq(workflows.id, workflowTagAssignments.workflowId),
        ),
      )
      .leftJoin(
        workflowOrganizationState,
        and(
          eq(
            workflowOrganizationState.workspaceId,
            workflowTagAssignments.workspaceId,
          ),
          eq(
            workflowOrganizationState.workflowId,
            workflowTagAssignments.workflowId,
          ),
        ),
      )
      .where(
        and(
          eq(workflowTagAssignments.workspaceId, scope.workspaceId),
          eq(workflowTagAssignments.tagId, tagId),
          after === null
            ? undefined
            : gt(workflowTagAssignments.workflowId, after),
        ),
      )
      .orderBy(asc(workflowTagAssignments.workflowId))
      .limit(limit + 1)
      .as('assignment_page');
    const result = await db
      .select({
        tagId: workflowTags.id,
        item: {
          workflowId: page.workflowId,
          organizationRevision: page.organizationRevision,
        },
      })
      .from(workflowTags)
      .leftJoin(page, sql`true`)
      .where(
        and(
          eq(workflowTags.workspaceId, scope.workspaceId),
          eq(workflowTags.id, tagId),
        ),
      )
      .orderBy(asc(page.workflowId))
      .catch(rethrowQueryFailure);
    if (result.length === 0)
      throw new WorkflowNotFoundError('Workflow is not visible');
    return pagination(
      result.flatMap((row) => (row.item === null ? [] : [row.item])),
      limit,
      (item) => item.workflowId,
    );
  });
}
