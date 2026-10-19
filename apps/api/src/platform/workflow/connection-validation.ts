import type {
  GraphValidationIssue,
  WorkflowGraph,
} from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';

/**
 * A step that sends through a connection can't publish without one. Checked
 * here so the person gets an issue on the step, before the publisher records
 * which connections each version uses.
 */
export function missingConnectionIssues(
  graph: WorkflowGraph,
  catalog: WorkflowDefinitionCatalog,
): readonly GraphValidationIssue[] {
  const slots = new Map(
    catalog.definitions.map((definition) => [
      `${definition.key}@${String(definition.version)}`,
      definition.integration?.connectionSlots ?? [],
    ]),
  );
  const issues: GraphValidationIssue[] = [];
  const levels = [{ graph, path: '$' }];
  for (const level of levels)
    for (const node of level.graph.nodes) {
      const path = `${level.path}.nodes.${node.id}`;
      if (node.structured !== undefined)
        levels.push({
          graph: node.structured.body,
          path: `${path}.structured.body`,
        });
      const required =
        slots.get(
          `${node.definition.key}@${String(node.definition.version)}`,
        ) ?? [];
      for (const slot of required)
        if (node.connectionRefs[slot] === undefined)
          issues.push({
            code: 'invalid_graph',
            path: `${path}.connectionRefs.${slot}`,
            message: 'Choose a connection for this step.',
          });
    }
  return issues;
}
