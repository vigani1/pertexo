import { canonicalJson } from '../../values/json/canonical.js';
import type { WorkflowGraph, WorkflowNode } from '../../graph/contract.js';

/** An equality binding for one step's setup; cosmetic edits and links are not inputs. */
export function stepSampleIdentity(node: WorkflowNode): string {
  return canonicalJson({
    definition: node.definition,
    configVersion: node.configVersion,
    config: node.config,
    inputMappings: node.inputMappings,
    connectionRefs: node.connectionRefs,
    disabled: node.disabled ?? false,
    ...(node.retry === undefined ? {} : { retry: node.retry }),
    structured:
      node.structured === undefined
        ? null
        : {
            kind: node.structured.kind,
            maxIterations: node.structured.maxIterations,
            maxConcurrency: node.structured.maxConcurrency,
            inputPorts: node.structured.body.inputPorts,
            outputPorts: node.structured.body.outputPorts,
            settings: node.structured.body.settings,
          },
  });
}

/** An ambiguous ID cannot own a sample, even while an invalid graph is editable. */
export function stepSampleBindings(
  graph: WorkflowGraph,
): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  const ambiguous = new Set<string>();
  const pending = [graph];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const node of current.nodes) {
      if (bindings.has(node.id)) ambiguous.add(node.id);
      bindings.set(node.id, stepSampleIdentity(node));
      if (node.structured !== undefined) pending.push(node.structured.body);
    }
  }
  for (const id of ambiguous) bindings.delete(id);
  return bindings;
}
