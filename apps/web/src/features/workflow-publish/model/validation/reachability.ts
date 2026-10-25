import type { WorkflowGraphContract } from '@pertexo/contracts';
import { isWorkflowTriggerKey } from '@pertexo/workflow-model';
import { describeStep } from '@/features/catalog/presentation.public';
import type { WorkflowIssue } from './issues';

/** Follow execution links, including failure paths and reachable loop bodies. */
export function unreachableStepIssues(
  graph: WorkflowGraphContract,
): readonly WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  function visit(level: WorkflowGraphContract, roots: readonly string[]) {
    const outgoing = new Map<string, string[]>();
    for (const edge of level.edges) {
      const targets = outgoing.get(edge.source.nodeId) ?? [];
      targets.push(edge.target.nodeId);
      outgoing.set(edge.source.nodeId, targets);
    }
    const reached = new Set<string>();
    const pending = [...roots];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || reached.has(id)) continue;
      reached.add(id);
      pending.push(...(outgoing.get(id) ?? []));
    }
    for (const node of level.nodes) {
      if (!reached.has(node.id))
        issues.push({
          id: `unreachable-${node.id}`,
          message: `${node.label ?? describeStep(node.definition.key).name} isn't linked from a trigger, so it never runs.`,
          target: { nodeId: node.id },
        });
      if (node.structured !== undefined) {
        const body = node.structured.body;
        const targets = new Set(body.edges.map((edge) => edge.target.nodeId));
        visit(
          body,
          reached.has(node.id)
            ? body.nodes
                .filter((step) => !targets.has(step.id))
                .map((step) => step.id)
            : [],
        );
      }
    }
  }
  visit(
    graph,
    graph.nodes
      .filter((node) => isWorkflowTriggerKey(node.definition.key))
      .map((node) => node.id),
  );
  return issues;
}
