import {
  CORE_SWITCH_CONFIG_SCHEMA,
  CORE_SWITCH_DEFINITION,
} from '@pertexo/nodes-core';
import {
  canonicalJson,
  type GraphValidationIssue,
  type WorkflowGraph,
} from '@pertexo/workflow-model';

/**
 * A Switch case whose value an earlier case already matches can never run.
 * Execution still accepts such a config, so published versions keep running;
 * only a new publication is asked to fix it.
 */
export function switchCaseIssues(
  graph: WorkflowGraph,
): readonly GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const levels = [{ graph, path: '$' }];
  for (const level of levels)
    for (const node of level.graph.nodes) {
      // A disabled step, and any loop body inside it, never runs.
      if (node.disabled) continue;
      const path = `${level.path}.nodes.${node.id}`;
      if (node.structured !== undefined)
        levels.push({
          graph: node.structured.body,
          path: `${path}.structured.body`,
        });
      if (
        node.definition.key !== CORE_SWITCH_DEFINITION.key ||
        node.definition.version !== CORE_SWITCH_DEFINITION.version
      )
        continue;
      const parsed = CORE_SWITCH_CONFIG_SCHEMA.safeParse(node.config);
      if (!parsed.success) continue;
      const seen = new Set<string>();
      for (const [index, item] of parsed.data.cases.entries()) {
        const value = canonicalJson(item.equals);
        if (seen.has(value))
          issues.push({
            code: 'invalid_graph',
            path: `${path}.config.cases[${String(index)}].equals`,
            message:
              'An earlier case already matches this value, so this case can never run.',
          });
        seen.add(value);
      }
    }
  return issues;
}
