import type { PoolClient } from 'pg';
import type { ExecutionCapabilityScope } from './execution-capability.types.js';
import { ExecutionCapabilityExpiredError } from '../node-attempt.errors.js';
import {
  lockCapabilityRows,
  shareLockWorkspaceStatus,
} from './fence.repository.js';

/**
 * Work runs only in an active workspace, and a preview capability names its own
 * run; then the rows it acts on are locked.
 */
export async function lockCapabilityExecution(
  client: PoolClient,
  input: ExecutionCapabilityScope,
): Promise<void> {
  if ((await shareLockWorkspaceStatus(client, input.workspaceId)) !== 'active')
    throw new ExecutionCapabilityExpiredError('The workspace is not active.');
  if (input.previewRunId !== undefined && input.previewRunId !== input.runId)
    throw new ExecutionCapabilityExpiredError();
  await lockCapabilityRows(client, input);
}
