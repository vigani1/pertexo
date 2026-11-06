import { compareOrdinal } from '../values/ordering.js';
import type { WorkflowGraph, WorkflowNode } from './workflow-graph.schemas.js';
import { parseWorkflowGraphDraft } from './validation/preflight.js';
import {
  EMPTY_DEFINITION_CATALOG,
  type WorkflowDefinitionCatalog,
} from './definition-catalog.js';
export type WorkflowIntegrationUsage = Readonly<{
  providerKey: string;
  operationKey: string;
  connectionId: string;
}>;

/**
 * Derive the exact integration index from a graph and its pinned definition
 * catalog. The result is disposable: the graph remains the sole authority.
 */
export function workflowIntegrationUsage(
  input: unknown,
  catalog: WorkflowDefinitionCatalog = EMPTY_DEFINITION_CATALOG,
): readonly WorkflowIntegrationUsage[] {
  const graph = parseWorkflowGraphDraft(input);
  const definitions = new Map(
    catalog.definitions.map((definition) => [
      `${definition.key}\u0000${String(definition.version)}`,
      definition.integration,
    ]),
  );
  const usages = new Map<string, WorkflowIntegrationUsage>();
  for (const node of enabledNodes(graph)) {
    const integration = definitions.get(
      `${node.definition.key}\u0000${String(node.definition.version)}`,
    );
    if (integration !== undefined) {
      for (const slot of integration.connectionSlots) {
        const connectionId = node.connectionRefs[slot];
        if (
          connectionId === undefined &&
          (integration.optionalConnectionSlots?.includes(slot) ?? false)
        )
          continue;
        if (connectionId === undefined) {
          throw new TypeError(
            `Integration definition ${node.definition.key}@${String(node.definition.version)} requires connection slot ${slot}`,
          );
        }
        const usage = Object.freeze({
          providerKey: integration.providerKey,
          operationKey: integration.operationKey,
          connectionId,
        });
        usages.set(
          `${usage.providerKey}\u0000${usage.operationKey}\u0000${usage.connectionId}`,
          usage,
        );
      }
    }
  }
  return Object.freeze(
    [...usages.values()].sort(
      (left, right) =>
        compareOrdinal(left.providerKey, right.providerKey) ||
        compareOrdinal(left.operationKey, right.operationKey) ||
        compareOrdinal(left.connectionId, right.connectionId),
    ),
  );
}

/** A disabled step, and any loop body inside it, uses no connection. */
function* enabledNodes(graph: WorkflowGraph): Generator<WorkflowNode> {
  for (const node of graph.nodes) {
    if (node.disabled ?? false) continue;
    yield node;
    if (node.structured !== undefined)
      yield* enabledNodes(node.structured.body);
  }
}
