import type { PoolClient } from 'pg';
import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';
import {
  lockWorkflowSettings,
  lockWorkspaceSettings,
} from './auto-pause-state.repository.js';

/**
 * Workspace default edits exclude outcome folds and workflow controls, which
 * take the same key shared.
 */
export async function lockWorkspace(
  client: PoolClient,
  workspaceId: string,
  input: Readonly<{ exclusive: boolean; statuses?: readonly string[] }>,
) {
  const found = await lockWorkspaceSettings(client, workspaceId, input);
  if (found === undefined)
    throw new WorkflowNotFoundError('Auto pause settings are not visible');
  return found;
}

export async function lockWorkflow(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const found = await lockWorkflowSettings(client, workspaceId, workflowId);
  if (found === undefined)
    throw new WorkflowNotFoundError('Auto pause settings are not visible');
  return found;
}
