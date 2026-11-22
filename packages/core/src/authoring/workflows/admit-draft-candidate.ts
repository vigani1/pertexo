import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';
import { lockArtifactReferences } from '../../artifacts/references/lock-references.js';
import type { WorkflowActor } from '../../shared/access/workflow-actor.types.js';
import { requireWorkflowCallTargets } from '../../shared/resources/require-workflow-call-targets.js';
import { requireConnectionBindings } from '../../shared/resources/require-connection-bindings.js';
import { requirePlaceableDefinitionAdditions } from './placement.js';

export async function admitDraftCandidate(
  client: PoolClient,
  actor: WorkflowActor,
  previous: WorkflowGraph,
  graph: WorkflowGraph,
  catalog: WorkflowDefinitionCatalog | undefined,
) {
  requirePlaceableDefinitionAdditions(previous, graph, catalog);
  await requireWorkflowCallTargets(client, actor, graph, previous);
  await requireConnectionBindings(client, actor, graph, previous);
  await lockArtifactReferences(client, actor.workspaceId, graph, actor.actorId);
}
