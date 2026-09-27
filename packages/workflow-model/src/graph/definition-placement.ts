import type { WorkflowGraph } from '../graph-contract.js';
import type { WorkflowDefinitionCatalogV1 } from './identity.js';

export type WorkflowDefinitionPlacementIssue = Readonly<{
  code: 'definition_not_placeable';
  path: string;
  message: string;
}>;

type LocatedNode = Readonly<{
  id: string;
  definition: Readonly<{ key: string; version: number }>;
  path: string;
}>;

function definitionToken(definition: LocatedNode['definition']): string {
  return `${definition.key}\u0000${String(definition.version)}`;
}

function nodeLocations(graph: WorkflowGraph): readonly LocatedNode[] {
  const result: LocatedNode[] = [];
  const pending: { graph: WorkflowGraph; path: string }[] = [
    { graph, path: '$' },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const node of current.graph.nodes) {
      const path = `${current.path}.nodes.${node.id}`;
      result.push({ id: node.id, definition: node.definition, path });
      if (node.structured !== undefined)
        pending.push({
          graph: node.structured.body,
          path: `${path}.structured.body`,
        });
    }
  }
  return result;
}

function occurrenceCounts(
  nodes: readonly LocatedNode[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const token = `${node.id}\u0000${definitionToken(node.definition)}`;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/** Retained unavailable occurrences remain valid; newly placed ones do not. */
export function workflowDefinitionPlacementIssues(
  previous: WorkflowGraph,
  next: WorkflowGraph,
  catalog: WorkflowDefinitionCatalogV1,
): readonly WorkflowDefinitionPlacementIssue[] {
  const placeable = new Set(catalog.definitions.map(definitionToken));
  const previousCounts = occurrenceCounts(nodeLocations(previous));
  const nextNodes = nodeLocations(next);
  const nextCounts = occurrenceCounts(nextNodes);
  const issues: WorkflowDefinitionPlacementIssue[] = [];
  for (const node of nextNodes) {
    const token = `${node.id}\u0000${definitionToken(node.definition)}`;
    if (previousCounts.get(token) === 1 && nextCounts.get(token) === 1)
      continue;
    if (placeable.has(definitionToken(node.definition))) continue;
    issues.push({
      code: 'definition_not_placeable',
      path: `${node.path}.definition`,
      message: `Definition ${node.definition.key}@${String(node.definition.version)} cannot be newly placed in the current compatibility release.`,
    });
  }
  return Object.freeze(issues.map((issue) => Object.freeze(issue)));
}
