import { DEFAULT_PAGE_LIMIT } from '../../../shared/page-limits.js';
import { WorkflowNotFoundError } from '../workflow-authoring.errors.js';
import { projectVersion } from '../representation/workflow-representations.repository.js';
import type { PoolClient } from 'pg';
import type { FolderScope } from '../../../shared/access/folder-access.types.js';
import { workflowAccessible } from '../../../shared/resources/workflow-access.repository.js';
import type { ListWorkflowVersionsInput } from '../workflow-commands.types.js';
import { workflowExists, readVersionPage } from './versions.repository.js';

export async function listVersions(
  client: PoolClient,
  scope: FolderScope,
  input: ListWorkflowVersionsInput,
) {
  if (
    !(await workflowAccessible(client, scope, {
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
    }))
  )
    throw new WorkflowNotFoundError('Workflow is not visible');
  const workflowId = input.workflowId;
  const visible = await workflowExists(client, input.workspaceId, workflowId);
  if (!visible) throw new WorkflowNotFoundError('Workflow is not visible');
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const beforeVersionNumber = input.beforeVersionNumber ?? null;
  const result = await readVersionPage(client, input, {
    limit,
    beforeVersionNumber,
  });
  const hasMore = result.length > limit;
  const items = Object.freeze(result.slice(0, limit).map(projectVersion));
  const last = items.at(-1);
  return Object.freeze({
    items,
    ...(hasMore && last !== undefined
      ? {
          nextCursor: Object.freeze({
            beforeVersionNumber: last.versionNumber,
          }),
        }
      : {}),
  });
}
