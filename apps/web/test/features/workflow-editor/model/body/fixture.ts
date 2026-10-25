import type { WorkflowGraphContract } from '@pertexo/contracts';
import { loopStep } from '../../../../support/fixtures/for-each';
import { emptyGraph } from '../../../../support/fixtures/workflow-editor';
export type WorkflowNode = WorkflowGraphContract['nodes'][number];

export function bodyOf(graph: WorkflowGraphContract, loopId = 'loop') {
  const body = graph.nodes.find((node) => node.id === loopId)?.structured?.body;
  if (body === undefined) throw new Error(`${loopId} has no body`);
  return body;
}

export function ids(nodes: readonly Pick<WorkflowNode, 'id'>[]) {
  return nodes.map((node) => node.id);
}

export function withBody(
  nodes: WorkflowNode[],
  edges: WorkflowGraphContract['edges'] = [],
): WorkflowGraphContract {
  return {
    ...emptyGraph,
    nodes: [loopStep('loop', 'Each', { nodes, edges: [...edges] })],
  };
}
