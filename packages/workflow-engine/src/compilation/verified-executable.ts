import type { NodeCatalog } from '@pertexo/node-sdk';
import {
  inspectControlNodeConfig,
  inspectWorkflowFailureRoutes,
  WORKFLOW_FAILURE_PORT,
  type ControlNodeConfig,
} from '@pertexo/workflow-model';
import type {
  CompiledWorkflowExecutable,
  WorkflowExecutableGraph,
  WorkflowExecutableNode,
  ExecutionFailureRoute,
  ExecutionNode,
} from './workflow-executable.js';
import { sameIdentity } from './definition-identity.js';
import { fail } from './executable-errors.js';
type VerifiedExecutableFacts = Readonly<{
  failureRoutes: readonly ExecutionFailureRoute[];
  nodes: readonly ExecutionNode[];
  controls: ReadonlyMap<string, ControlNodeConfig>;
  readOnlyNodeIds: ReadonlySet<string>;
}>;
const authenticExecutableIdentities = new WeakMap<
  object,
  VerifiedExecutableFacts
>();

export function registerExecutableIdentity(
  value: CompiledWorkflowExecutable,
  catalog: NodeCatalog,
): CompiledWorkflowExecutable {
  const routing = inspectWorkflowFailureRoutes(value.envelope.graph);
  if (routing.kind === 'invalid') fail(routing.message);
  const adjacency = new Map<string, string[]>();
  if (routing.kind === 'routed')
    for (const { source, target } of value.envelope.graph.edges) {
      if (
        source.port === WORKFLOW_FAILURE_PORT ||
        routing.value.handlerOwners.has(source.nodeId)
      )
        continue;
      const children = adjacency.get(source.nodeId) ?? [];
      children.push(target.nodeId);
      adjacency.set(source.nodeId, children);
    }
  const routes =
    routing.kind === 'routed'
      ? [...routing.value.routes.values()].map((route) => {
          const suffix = new Set<string>();
          const pending = [...(adjacency.get(route.sourceNodeId) ?? [])];
          while (pending.length > 0) {
            const nodeId = pending.pop();
            if (nodeId === undefined) break;
            if (suffix.has(nodeId)) continue;
            suffix.add(nodeId);
            pending.push(...(adjacency.get(nodeId) ?? []));
          }
          return Object.freeze({
            ...route,
            normalSuffixNodeIds: Object.freeze([...suffix]),
          });
        })
      : [];
  const nodes = withControls(value.envelope.graph);
  authenticExecutableIdentities.set(
    value,
    Object.freeze({
      failureRoutes: Object.freeze(routes),
      nodes: Object.freeze(nodes),
      controls: new Map(
        nodes.flatMap(({ id, control }) =>
          control === undefined ? [] : [[id, control] as const],
        ),
      ),
      readOnlyNodeIds: new Set(
        nodes
          .filter((node) => attemptsOnlyRead(node, catalog))
          .map(({ id }) => id),
      ),
    }),
  );
  return value;
}

function withControls(graph: WorkflowExecutableGraph): ExecutionNode[] {
  return graph.nodes.flatMap((node): ExecutionNode[] => {
    // Only a new compilation refuses a setup the schemas reject. A version
    // published before that keeps verifying, as a step without a control
    // setup, and that step fails on its own when it runs.
    const inspected = inspectControlNodeConfig(node);
    return [
      inspected.kind === 'valid'
        ? Object.freeze({ ...node, control: inspected.value })
        : node,
      ...(node.structured === undefined
        ? []
        : withControls(node.structured.body)),
    ];
  });
}

function attemptsOnlyRead(
  node: WorkflowExecutableNode,
  catalog: NodeCatalog,
): boolean {
  const condition = catalog.definitions.find(({ definition }) =>
    sameIdentity(definition, node.definition),
  )?.readOnlyWhen;
  if (condition === undefined) return false;
  const value = node.config[condition.configKey];
  return typeof value === 'string' && condition.values.includes(value);
}

export function assertAuthenticExecutableIdentity(
  value: CompiledWorkflowExecutable,
): void {
  if (!authenticExecutableIdentities.has(value))
    fail('workflow executable identity was not verified in this process');
}

export function executableFailureRoutes(
  value: CompiledWorkflowExecutable,
): readonly ExecutionFailureRoute[] {
  return verifiedFacts(value).failureRoutes;
}

/** Every step of a verified executable, loop bodies included, in graph order. */
export function executionNodes(
  value: CompiledWorkflowExecutable,
): readonly ExecutionNode[] {
  return verifiedFacts(value).nodes;
}

export function executableReadOnlyNodeIds(
  value: CompiledWorkflowExecutable,
): ReadonlySet<string> {
  return verifiedFacts(value).readOnlyNodeIds;
}

export function executableControls(
  value: CompiledWorkflowExecutable,
): ReadonlyMap<string, ControlNodeConfig> {
  return verifiedFacts(value).controls;
}

function verifiedFacts(
  value: CompiledWorkflowExecutable,
): VerifiedExecutableFacts {
  const facts = authenticExecutableIdentities.get(value);
  if (facts === undefined)
    fail('workflow executable identity was not verified in this process');
  return facts;
}
