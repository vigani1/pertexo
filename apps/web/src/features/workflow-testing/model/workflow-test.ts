import { describeStep, type DescribeStep } from '@/features/catalog/public';
import type { WorkflowGraphContract } from '@pertexo/contracts';
export function workflowTestStepLabels(
  graph: WorkflowGraphContract | undefined,
  describe: DescribeStep = describeStep,
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
      node.label ?? describe(node.definition).name,
    ]),
  );
}
