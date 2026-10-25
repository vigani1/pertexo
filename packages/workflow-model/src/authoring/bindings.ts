import { z } from 'zod';
import { canonicalJson } from '../values/json/canonical.js';
import type { WorkflowGraph } from '../graph/contract.js';
import {
  isWorkflowCallDefinition,
  workflowCallConfigSchema,
} from '../flow/callable/invocation.js';

const uuidSchema = z.uuid();

function callTargets(graph: WorkflowGraph): Map<string, string> {
  const targets = new Map<string, string>();
  const pending: { graph: WorkflowGraph; path: readonly string[] }[] = [
    { graph, path: [] },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const node of current.graph.nodes) {
      if (isWorkflowCallDefinition(node.definition)) {
        // Incomplete draft configuration is not an executable binding yet.
        const parsed = workflowCallConfigSchema.safeParse(node.config);
        if (parsed.success)
          targets.set(
            canonicalJson([
              [...current.path, node.id],
              node.definition,
              parsed.data.target,
            ]),
            parsed.data.target.workflowId,
          );
      }
      if (node.structured !== undefined)
        pending.push({
          graph: node.structured.body,
          path: [...current.path, node.id],
        });
    }
  }
  return targets;
}

type ConnectionReference = Readonly<{
  id: string;
  path: string;
  enabled: boolean;
}>;
function bindings(graph: WorkflowGraph): Map<string, ConnectionReference> {
  const result = new Map<string, ConnectionReference>();
  const pending: {
    graph: WorkflowGraph;
    path: readonly string[];
    enabled: boolean;
  }[] = [{ graph, path: [], enabled: true }];
  for (const level of pending)
    for (const node of level.graph.nodes) {
      const path = [...level.path, node.id];
      const enabled = level.enabled && !(node.disabled ?? false);
      for (const [slot, id] of Object.entries(node.connectionRefs))
        result.set(
          canonicalJson([path, node.definition, slot, id.toLowerCase()]),
          {
            id,
            enabled,
            path: `$.${path.map((id) => `nodes.${id}`).join('.structured.body.')}.connectionRefs.${slot}`,
          },
        );
      if (node.structured !== undefined)
        pending.push({ graph: node.structured.body, path, enabled });
    }
  return result;
}

export function workflowConnectionReferences(
  graph: WorkflowGraph,
): readonly ConnectionReference[] {
  return [...bindings(graph).values()];
}
export function connectionReferenceIds(
  references: readonly { id: string }[],
): string[] {
  return [
    ...new Set(
      references.flatMap((reference) => {
        const parsed = uuidSchema.safeParse(reference.id);
        return parsed.success ? [parsed.data.toLowerCase()] : [];
      }),
    ),
  ];
}

export function addedWorkflowCallTargets(
  graph: WorkflowGraph,
  previous?: WorkflowGraph,
): readonly string[] {
  const existing =
    previous === undefined ? new Map<string, string>() : callTargets(previous);
  return [
    ...new Set(
      [...callTargets(graph)]
        .filter(([key]) => !existing.has(key))
        .map(([, id]) => id),
    ),
  ];
}

export function addedWorkflowConnectionReferences(
  graph: WorkflowGraph,
  previous?: WorkflowGraph,
): readonly ConnectionReference[] {
  const before = new Set(
    previous === undefined ? [] : bindings(previous).keys(),
  );
  return [...bindings(graph)]
    .filter(([key]) => !before.has(key))
    .map(([, reference]) => reference);
}
