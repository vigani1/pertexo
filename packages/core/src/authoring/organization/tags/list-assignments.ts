import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';

import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';

import type { createOrganizationSession } from '../session.js';

import type {
  ListTagAssignmentsInput,
  Page,
  WorkflowTagAssignment,
} from './workflow-tag.types.js';
import { page, pagination } from './tag-state.repository.js';
import { readAssignmentPage } from './list.repository.js';

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
      const result = await readAssignmentPage(client, scope.workspaceId, {
        tagId,
        after,
        limit,
      });
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
