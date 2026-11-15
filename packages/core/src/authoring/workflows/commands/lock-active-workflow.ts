import type { WorkflowRef } from '../../../shared/workflow-actor.types.js';
import type { PoolClient } from 'pg';
import { WorkflowNotFoundError } from '../workflow-authoring.errors.js';
import { lockActiveWorkflowRow } from './locks.repository.js';

/**
 * The workflow and then its draft, in that order everywhere a command takes both:
 * publication, restoring a version and duplicating a draft. An archived workflow
 * is read-only, so it reads as missing.
 */
export async function lockActiveWorkflow(
  client: PoolClient,
  options: WorkflowRef,
): Promise<void> {
  if (!(await lockActiveWorkflowRow(client, options)))
    throw new WorkflowNotFoundError('Workflow is not visible');
}
