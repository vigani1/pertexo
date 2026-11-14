import type { WorkflowGraph } from '../../graph/workflow-graph.schemas.js';
import { WORKFLOW_TEST_LIMITS } from './workflow-test-expectations.schemas.js';
/** Frozen and current test UIs use the same names, including nested steps. */
export function workflowTestStepChoices(
  graph: WorkflowGraph,
): readonly Readonly<{ nodeId: string; label: string }>[] {
  return graph.nodes.flatMap((node) => {
    const label = node.label?.trim() ?? '';
    return [
      {
        nodeId: node.id,
        label: Array.from(label.length === 0 ? node.definition.key : label)
          .slice(0, WORKFLOW_TEST_LIMITS.stepLabelCharacters)
          .join(''),
      },
      ...(node.structured === undefined
        ? []
        : workflowTestStepChoices(node.structured.body)),
    ];
  });
}
