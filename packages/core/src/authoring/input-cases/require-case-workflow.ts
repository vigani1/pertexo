import type { PoolClient } from 'pg';
import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';
import type { Scope } from './workflow-input-case.types.js';
import { shareCaseWorkflow } from './metadata.repository.js';

/** The workflow must be visible, and active for a write. */
export async function requireCaseWorkflow(
  client: PoolClient,
  input: Scope,
  { write }: Readonly<{ write: boolean }>,
): Promise<void> {
  const row = await shareCaseWorkflow(client, input);
  if (row === undefined || (write && row.lifecycleStatus !== 'active'))
    throw new WorkflowNotFoundError('Workflow is not visible');
}
