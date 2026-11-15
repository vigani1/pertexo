import type { PoolClient } from 'pg';
import {
  addedWorkflowCallTargets,
  InvalidWorkflowGraphError,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { ResourceActor } from '../folder-access.types.js';
import { countReadableWorkflows } from './workflow-call-bindings.repository.js';

/** Only direct bindings are admitted; immutable child versions delegate their own closure. */
export async function requireWorkflowCallTargets(
  client: PoolClient,
  actor: ResourceActor,
  graph: WorkflowGraph,
  previous?: WorkflowGraph,
): Promise<void> {
  const targets = addedWorkflowCallTargets(graph, previous);
  if (targets.length === 0) return;
  if ((await countReadableWorkflows(client, actor, targets)) !== targets.length)
    throw new InvalidWorkflowGraphError([
      {
        code: 'invalid_graph',
        path: '$.nodes',
        message:
          'A Call target is unavailable. Choose a workflow you can read.',
      },
    ]);
}
