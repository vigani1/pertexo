import { describeStep } from '@/features/catalog/presentation.public';
import type { WorkflowGraphContract } from '@pertexo/contracts';
export function workflowTestStepLabels(
  graph: WorkflowGraphContract | undefined,
): ReadonlyMap<string, string> {
  if (graph === undefined) return new Map();
  const nodes = (function flatten(
    nodes: WorkflowGraphContract['nodes'],
  ): WorkflowGraphContract['nodes'] {
    return nodes.flatMap((node) => [
      node,
      ...(node.structured === undefined
        ? []
        : flatten(node.structured.body.nodes)),
    ]);
  })(graph.nodes);
  return new Map(
    nodes.map((node) => [
      node.id,
      node.label ?? describeStep(node.definition.key).name,
    ]),
  );
}
