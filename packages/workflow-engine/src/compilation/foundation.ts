import { createHash } from 'node:crypto';
import {
  NODE_JSON_LIMITS,
  type DefinitionIdentity,
  type ExecutorIdentity,
  type PolicyReference,
  type NodeCatalog,
} from '@pertexo/node-sdk';
import {
  canonicalJson,
  inspectControlNodeConfig,
  inspectWorkflowFailureRoutes,
  type ControlNodeConfig,
  WORKFLOW_FAILURE_PORT,
  type WorkflowFailureRoute,
  type JsonValue,
  type ValueSource,
  type WorkflowEdge,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { WorkflowEngineError } from '../errors.js';
import type { SideEffectClass } from '../types.js';
export { compareOrdinal } from '@pertexo/workflow-model';

export const BASELINE_RUNTIME_POLICIES = Object.freeze({
  scheduler: Object.freeze({ key: 'engine.scheduler', version: 1 }),
  checkpoint: Object.freeze({ key: 'engine.checkpoint', version: 1 }),
  retry: Object.freeze({ key: 'engine.retry', version: 1 }),
  timeout: Object.freeze({ key: 'engine.timeout', version: 1 }),
  cancellation: Object.freeze({ key: 'engine.cancellation', version: 1 }),
});
/**
 * An executable holds the whole graph, so its member limit is sized for the
 * graph's node limit rather than for one node's input or output.
 */
export const WORKFLOW_EXECUTABLE_LIMITS = Object.freeze({
  bytes: NODE_JSON_LIMITS.bytes,
  depth: NODE_JSON_LIMITS.depth,
  members: 100_000,
});

export interface ExecutableRuntimePolicies {
  readonly scheduler: PolicyReference;
  readonly checkpoint: PolicyReference;
  readonly retry: PolicyReference;
  readonly timeout: PolicyReference;
  readonly cancellation: PolicyReference;
}

export interface WorkflowExecutableNode {
  readonly id: string;
  readonly definition: DefinitionIdentity;
  readonly configVersion: number;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly inputMappings: Readonly<Record<string, ValueSource>>;
  readonly connectionRefs: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly retry?: WorkflowGraph['nodes'][number]['retry'];
  readonly sideEffectClass: SideEffectClass;
  readonly executor: ExecutorIdentity;
  readonly executorAbi: number;
  readonly policyReferences: readonly PolicyReference[];
  readonly structured?: WorkflowExecutableForEach | undefined;
}

export interface WorkflowExecutableGraph {
  readonly settings: WorkflowGraph['settings'];
  readonly callable?: WorkflowGraph['callable'];
  readonly nodes: readonly WorkflowExecutableNode[];
  readonly edges: readonly WorkflowEdge[];
}

interface WorkflowExecutableStructuredBody extends WorkflowExecutableGraph {
  readonly inputPorts: readonly string[];
  readonly outputPorts: readonly string[];
}

export interface WorkflowExecutableForEach {
  readonly kind: 'for_each';
  readonly maxIterations: number;
  readonly maxConcurrency: number;
  readonly body: WorkflowExecutableStructuredBody;
}

export interface WorkflowExecutable {
  readonly graph: WorkflowExecutableGraph;
  readonly runtimePolicies: ExecutableRuntimePolicies;
}

declare const verifiedExecutable: unique symbol;
export type VerifiedWorkflowExecutable = WorkflowExecutable & {
  readonly [verifiedExecutable]: true;
};

export interface CompiledWorkflowExecutable {
  readonly envelope: VerifiedWorkflowExecutable;
  readonly checksum: `wf:sha256:${string}`;
}
export type ExecutionFailureRoute = WorkflowFailureRoute &
  Readonly<{ normalSuffixNodeIds: readonly string[] }>;
/** A verified step with its parsed control setup; the stored executable keeps only its config. */
export type ExecutionNode = WorkflowExecutableNode &
  Readonly<{ control?: ControlNodeConfig }>;
type VerifiedExecutableFacts = Readonly<{
  failureRoutes: readonly ExecutionFailureRoute[];
  nodes: readonly ExecutionNode[];
  controls: ReadonlyMap<string, ControlNodeConfig>;
}>;
const authenticExecutableIdentities = new WeakMap<
  object,
  VerifiedExecutableFacts
>();

export function registerExecutableIdentity(
  value: CompiledWorkflowExecutable,
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
    }),
  );
  return value;
}

function withControls(graph: WorkflowExecutableGraph): ExecutionNode[] {
  return graph.nodes.flatMap((node): ExecutionNode[] => {
    const inspected = inspectControlNodeConfig(node);
    if (inspected.kind === 'invalid') fail(inspected.message);
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

export const token = (
  value: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): string => `${value.key}\u0000${String(value.version)}`;
export function compareIdentity(
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): number {
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return left.version - right.version;
}
export const sameIdentity = (
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): boolean => left.key === right.key && left.version === right.version;
export function fail(message: string): never {
  throw new WorkflowEngineError('executable_invalid', message);
}

export function normalizeError(error: unknown): never {
  let isEngineError = false;
  try {
    isEngineError = error instanceof WorkflowEngineError;
  } catch {
    // Hostile rejection values are normalized below.
  }
  if (isEngineError) throw error;
  let message: string | undefined;
  try {
    if (error instanceof Error && typeof error.message === 'string')
      message = error.message;
  } catch {
    // Hostile rejection values are normalized below.
  }
  fail(message ?? 'executable processing failed');
}

export function freezeExecutable<T extends object>(value: T): T {
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const children = Object.values(current) as unknown[];
    for (const child of children)
      if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(current);
  }
  return value;
}

export function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ domain, value }))
    .digest('hex');
}

export function globalPolicies(
  policies: ExecutableRuntimePolicies,
): readonly PolicyReference[] {
  return [
    policies.scheduler,
    policies.checkpoint,
    policies.retry,
    policies.timeout,
    policies.cancellation,
  ];
}

export function validateGlobals(
  policies: ExecutableRuntimePolicies,
  catalog: NodeCatalog,
): void {
  const selected = globalPolicies(policies);
  const expected = globalPolicies(BASELINE_RUNTIME_POLICIES);
  if (
    !selected.every((value, index) => {
      const expectedValue = expected[index];
      return expectedValue !== undefined && sameIdentity(value, expectedValue);
    }) ||
    new Set(selected.map(token)).size !== selected.length
  )
    fail('runtime policy selection is not baseline policy v1');
  const available = new Set(catalog.policies.map(token));
  if (!selected.every((value) => available.has(token(value))))
    fail('node catalog is missing a runtime policy');
}
