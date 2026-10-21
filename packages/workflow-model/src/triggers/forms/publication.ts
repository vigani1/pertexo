import { formConfigSchema } from './fields.js';
import type { WorkflowGraph } from '../../graph/contract.js';
import type { GraphValidationIssue } from '../../graph/validation/contract.js';

/** Form admission supplies one entry, never a second implicitly active root. */
export function formDeclarationIssues(
  graph: WorkflowGraph,
): readonly GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const levels = [{ graph, path: '$' }];
  let found = 0;
  for (const level of levels)
    for (const [index, node] of level.graph.nodes.entries()) {
      if (node.structured !== undefined)
        levels.push({
          graph: node.structured.body,
          path: `${level.path}.nodes[${String(index)}].structured.body`,
        });
      if (node.definition.key !== 'core.form') continue;
      found++;
      const config = formConfigSchema.safeParse(node.config);
      if (!config.success)
        for (const error of config.error.issues.slice(0, 20))
          issues.push({
            code: 'invalid_graph',
            path: `${level.path}.nodes[${String(index)}].config${error.path.map((part) => `.${String(part)}`).join('')}`,
            message: error.message,
          });
      if (level.path !== '$' || node.definition.version !== 1 || found > 1)
        issues.push({
          code: 'invalid_graph',
          path: level.path,
          message: 'Use one Form trigger in the workflow root, outside loops.',
        });
      const roots = level.graph.nodes.filter(
        (candidate) =>
          !level.graph.edges.some(
            (edge) => edge.target.nodeId === candidate.id,
          ),
      );
      if (roots.length !== 1 || roots[0]?.id !== node.id)
        issues.push({
          code: 'invalid_graph',
          path: level.path,
          message: 'The Form trigger must be the workflow’s only entry.',
        });
    }
  return issues;
}
