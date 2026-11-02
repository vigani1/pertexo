import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowOrganizationState,
  workflowTagAssignments,
  workflowTags,
  workflows,
} from '@pertexo/database/schema';

import { WorkflowNotFoundError } from '../../workflows/errors.js';

import type { createOrganizationSession } from '../session.js';
import type {
  ListTagAssignmentsInput,
  ListTagsInput,
  Page,
  WorkflowTagAssignment,
  WorkflowTagRecord,
} from './contract.js';
import { page, pagination, tagProjection } from './state.queries.js';

export async function listTags(
  session: ReturnType<typeof createOrganizationSession>,
  input: ListTagsInput,
): Promise<Page<WorkflowTagRecord>> {
  const { limit, after } = page(input);
  return session.read(
    input,
    'workflow:read',
    BROWSABLE_WORKSPACE_STATUSES,
    async (client, scope) => {
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
    },
  );
}

export async function listTagAssignments(
  session: ReturnType<typeof createOrganizationSession>,
  input: ListTagAssignmentsInput,
): Promise<Page<WorkflowTagAssignment>> {
  const { limit, after } = page(input),
    tagId = input.tagId;
  return session.read(
    input,
    'governance:manage',
    BROWSABLE_WORKSPACE_STATUSES,
    async (client, scope) => {
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
    },
  );
}
