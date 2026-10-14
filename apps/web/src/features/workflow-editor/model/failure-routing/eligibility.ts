import {
  inspectWorkflowFailureRoutes,
  isWorkflowFailureSource,
} from '@pertexo/workflow-model';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { findStep, scopeOf } from '../graph/scopes';

export function canOwnFailureLink(
  graph: WorkflowGraphContract,
  nodeId: string,
): boolean {
  const node = findStep(graph, nodeId);
  if (
    node === undefined ||
    scopeOf(graph, nodeId)?.length !== 0 ||
    !isWorkflowFailureSource(node.definition)
  )
    return false;
  const inspected = inspectWorkflowFailureRoutes(graph);
  return (
    inspected.kind !== 'routed' || !inspected.value.handlerOwners.has(nodeId)
  );
}
