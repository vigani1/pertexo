import type { ValueSource } from '../../graph/contract.js';
import {
  callbackWaitConfigSchema,
  isCallbackWaitNode,
  CALLBACKS_PER_STEP,
} from './contract.js';
import type { CallbackReference } from './references.js';

type Node = Readonly<{
  id: string;
  definition: Readonly<{ key: string; version: number }>;
  config: Readonly<Record<string, unknown>>;
  disabled?: boolean | undefined;
}>;
type Graph = Readonly<{
  nodes: readonly Node[];
  edges: readonly Readonly<{
    source: Readonly<{ nodeId: string }>;
    target: Readonly<{ nodeId: string }>;
  }>[];
}>;
function reachableNodes(graph: Graph, nodeId: string): ReadonlySet<string> {
  const reachable = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of graph.edges)
      if (edge.source.nodeId === id) pending.push(edge.target.nodeId);
  }
  return reachable;
}
export function callbackTargetNodes<N extends Node>(
  graph: Readonly<{ nodes: readonly N[]; edges: Graph['edges'] }>,
  nodeId: string,
): readonly N[] {
  const reachable = reachableNodes(graph, nodeId);
  return graph.nodes.filter(
    (node) =>
      node.id !== nodeId &&
      reachable.has(node.id) &&
      !(node.disabled ?? false) &&
      isCallbackWaitNode(node) &&
      callbackWaitConfigSchema.safeParse(node.config).success,
  );
}
export function callbackMappingExpression(
  nodeId: string,
  field: CallbackReference['field'],
): string {
  return `$lookup($execution.callbacks,${JSON.stringify(nodeId)}).${field}`;
}
/** A credential is delivered transiently, never made an ordinary data-step result. */
export function callbackReferenceIssue(
  references: readonly CallbackReference[],
  graph: Graph | undefined,
  nodeId: string | undefined,
  { externalHttp }: Readonly<{ externalHttp: boolean }>,
): string | undefined {
  if (references.length === 0) return undefined;
  if (
    new Set(references.map((reference) => reference.nodeId)).size >
    CALLBACKS_PER_STEP
  )
    return 'Reference at most 16 callback Waits from one sending step.';
  if (!externalHttp || graph === undefined || nodeId === undefined)
    return 'Callback credentials can be sent by an HTTP, Slack or email step, not saved as ordinary step data.';
  const reachable = reachableNodes(graph, nodeId);
  for (const reference of references) {
    const target = graph.nodes.find((node) => node.id === reference.nodeId);
    const invalidTarget =
      target === undefined ||
      !isCallbackWaitNode(target) ||
      (target.disabled ?? false) ||
      target.id === nodeId ||
      !reachable.has(target.id);
    if (invalidTarget)
      return 'Select an enabled callback Wait after this step in the same workflow or loop body.';
    const config = callbackWaitConfigSchema.safeParse(target.config);
    if (!config.success) return 'Correct the selected callback Wait settings.';
    if (
      reference.field === 'secret' &&
      config.data.authentication.mode === 'secret_url'
    )
      return 'This Wait uses its secret URL only; select its URL instead of an authentication secret.';
  }
  return undefined;
}
export function hasCallbackMapping(
  sources: Readonly<Record<string, ValueSource>>,
  inspect: (
    expression: string,
  ) => Readonly<{ kind: string; callbacks?: readonly CallbackReference[] }>,
): boolean {
  return Object.values(sources).some(
    (source) =>
      source.kind === 'expression' &&
      (inspect(source.expression).callbacks?.length ?? 0) > 0,
  );
}
