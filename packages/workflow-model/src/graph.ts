import './server-only.js';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  inspectJsonValue,
  type JsonValue,
} from './canonical-json.js';

export type NodeId = string;
export type ValueSource =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'run_input'; readonly path: string }
  | {
      readonly kind: 'node_output';
      readonly nodeId: NodeId;
      readonly path: string;
    }
  | {
      readonly kind: 'expression';
      readonly language: 'jsonata';
      readonly expression: string;
      readonly policyVersion: number;
    };
export interface WorkflowEdge {
  readonly id: string;
  readonly source: { readonly nodeId: NodeId; readonly port: string };
  readonly target: { readonly nodeId: NodeId; readonly port: string };
}
export type WorkflowSettings = Readonly<Record<string, JsonValue>>;
export interface StructuredBody extends WorkflowGraph {
  readonly inputPorts: readonly string[];
  readonly outputPorts: readonly string[];
}
export interface ForEachStructure {
  readonly kind: 'for_each';
  readonly maxIterations: number;
  readonly maxConcurrency: number;
  readonly body: StructuredBody;
}
export interface WorkflowNode {
  readonly id: NodeId;
  readonly definition: { readonly key: string; readonly version: number };
  readonly position: { readonly x: number; readonly y: number };
  readonly configVersion: number;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly inputMappings: Readonly<Record<string, ValueSource>>;
  readonly connectionRefs: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly structured?: ForEachStructure;
}
export interface WorkflowGraph {
  readonly schemaVersion: number;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly settings: WorkflowSettings;
}

export interface WorkflowGraphLimits {
  readonly nodes: number;
  readonly edges: number;
  readonly graphBytes: number;
  readonly maxLoopIterations: number;
  readonly maxLoopConcurrency: number;
  readonly maxExpandedInvocations: number;
}
export const WORKFLOW_GRAPH_LIMITS: WorkflowGraphLimits = Object.freeze({
  nodes: 1_000,
  edges: 4_000,
  graphBytes: 1_048_576,
  maxLoopIterations: 1_000,
  maxLoopConcurrency: 1_000,
  maxExpandedInvocations: 1_000,
});
export type GraphIssueCode =
  | 'duplicate_node_id'
  | 'duplicate_edge_id'
  | 'dangling_edge'
  | 'cycle'
  | 'invalid_loop_limit'
  | 'invalid_structured_body'
  | 'expansion_limit'
  | 'graph_limit'
  | 'invalid_graph';
export interface GraphValidationIssue {
  readonly code: GraphIssueCode;
  readonly path: string;
  readonly message: string;
}
export type GraphValidationResult =
  | {
      readonly ok: true;
      readonly issues: readonly [];
      readonly expandedInvocations: number;
    }
  | {
      readonly ok: false;
      readonly issues: readonly GraphValidationIssue[];
      readonly expandedInvocations: number;
    };

function isForEachStructure(value: unknown): value is ForEachStructure {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { readonly kind?: unknown }).kind === 'for_each'
  );
}

export function validateWorkflowGraph(
  graph: WorkflowGraph,
  overrides: Partial<WorkflowGraphLimits> = {},
): GraphValidationResult {
  const limits = { ...WORKFLOW_GRAPH_LIMITS, ...overrides };
  const issues: GraphValidationIssue[] = [];
  const globalNodeIds = new Set<string>();
  const aggregate = { nodes: 0, edges: 0 };
  const issue = (code: GraphIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message });
  };
  const validate = (current: WorkflowGraph, path: string): number => {
    if (current.schemaVersion !== 1)
      issue(
        'invalid_graph',
        `${path}.schemaVersion`,
        'schemaVersion must be exactly 1',
      );
    aggregate.nodes += current.nodes.length;
    aggregate.edges += current.edges.length;
    if (aggregate.nodes > limits.nodes || aggregate.edges > limits.edges)
      issue('graph_limit', path, 'node or edge count exceeds the graph limit');
    const localIds = new Set<string>();
    const edgeIds = new Set<string>();
    for (const currentNode of current.nodes) {
      if (localIds.has(currentNode.id) || globalNodeIds.has(currentNode.id))
        issue(
          'duplicate_node_id',
          `${path}.nodes`,
          `duplicate node ${currentNode.id}`,
        );
      localIds.add(currentNode.id);
      globalNodeIds.add(currentNode.id);
    }
    const adjacency = new Map<string, string[]>();
    for (const id of localIds) adjacency.set(id, []);
    for (const edge of current.edges) {
      if (edgeIds.has(edge.id))
        issue(
          'duplicate_edge_id',
          `${path}.edges`,
          `duplicate edge ${edge.id}`,
        );
      edgeIds.add(edge.id);
      if (
        !localIds.has(edge.source.nodeId) ||
        !localIds.has(edge.target.nodeId)
      )
        issue(
          'dangling_edge',
          `${path}.edges.${edge.id}`,
          'ordinary edges cannot cross a structured-body seam',
        );
      else adjacency.get(edge.source.nodeId)?.push(edge.target.nodeId);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) {
        issue('cycle', path, `cycle contains ${id}`);
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const next of adjacency.get(id) ?? []) visit(next);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of [...localIds].sort()) visit(id);
    let expansion = 0;
    for (const currentNode of current.nodes) {
      expansion += 1;
      if (!currentNode.structured) continue;
      const structured: unknown = currentNode.structured;
      if (!isForEachStructure(structured)) {
        issue(
          'invalid_structured_body',
          `${path}.nodes.${currentNode.id}.structured.kind`,
          'structured nodes must use kind for_each',
        );
        continue;
      }
      const loop = structured;
      if (
        !Number.isInteger(loop.maxIterations) ||
        loop.maxIterations < 1 ||
        loop.maxIterations > limits.maxLoopIterations ||
        !Number.isInteger(loop.maxConcurrency) ||
        loop.maxConcurrency < 1 ||
        loop.maxConcurrency > loop.maxIterations ||
        loop.maxConcurrency > limits.maxLoopConcurrency
      )
        issue(
          'invalid_loop_limit',
          `${path}.nodes.${currentNode.id}.structured`,
          'For Each limits must be positive, bounded, and concurrency cannot exceed iterations',
        );
      if (
        new Set(loop.body.inputPorts).size !== loop.body.inputPorts.length ||
        new Set(loop.body.outputPorts).size !== loop.body.outputPorts.length
      )
        issue(
          'invalid_structured_body',
          `${path}.nodes.${currentNode.id}.structured.body`,
          'structured ports must be unique',
        );
      const bodyExpansion = validate(
        loop.body,
        `${path}.nodes.${currentNode.id}.structured.body`,
      );
      expansion += Math.max(0, loop.maxIterations) * bodyExpansion;
    }
    return expansion;
  };
  let expandedInvocations = 0;
  try {
    if (inspectJsonValue(graph).bytes > limits.graphBytes)
      issue('graph_limit', '$', 'canonical graph bytes exceed the limit');
    expandedInvocations = validate(graph, '$');
  } catch (error) {
    issue(
      'invalid_graph',
      '$',
      error instanceof Error ? error.message : 'graph is not canonical JSON',
    );
  }
  if (expandedInvocations > limits.maxExpandedInvocations)
    issue(
      'expansion_limit',
      '$',
      `worst-case expansion ${String(expandedInvocations)} exceeds ${String(limits.maxExpandedInvocations)}`,
    );
  return issues.length === 0
    ? { ok: true, issues: [], expandedInvocations }
    : { ok: false, issues, expandedInvocations };
}

export type InvocationScopePart =
  | { readonly kind: 'branch'; readonly branchId: string }
  | {
      readonly kind: 'iteration';
      readonly loopNodeId: string;
      readonly ordinal: number;
    };
export interface InvocationIdentityInput {
  readonly workflowRunId: string;
  readonly workflowVersionId: string;
  readonly nodeId: NodeId;
  readonly scope: readonly InvocationScopePart[];
}
export class InvalidInvocationScopeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInvocationScopeError';
  }
}
export function invocationIdentity(input: InvocationIdentityInput): {
  readonly workflowRunId: string;
  readonly canonicalScope: string;
  readonly invocationKey: string;
} {
  if (!input.workflowRunId || !input.workflowVersionId || !input.nodeId)
    throw new InvalidInvocationScopeError(
      'run, version, and node identifiers must be non-empty',
    );
  for (const part of input.scope) {
    if (part.kind === 'branch' && !part.branchId)
      throw new InvalidInvocationScopeError(
        'branch identifiers must be non-empty',
      );
    if (
      part.kind === 'iteration' &&
      (!part.loopNodeId ||
        !Number.isSafeInteger(part.ordinal) ||
        part.ordinal < 0)
    )
      throw new InvalidInvocationScopeError(
        'loop scopes require a non-empty node and zero-based safe ordinal',
      );
  }
  const canonicalScope = input.scope
    .map((part) =>
      part.kind === 'branch'
        ? `branch:${encodeURIComponent(part.branchId)}`
        : `loop:${encodeURIComponent(part.loopNodeId)}[${String(part.ordinal)}]`,
    )
    .join('/');
  const invocationKey = createHash('sha256')
    .update(
      canonicalJson({
        version: input.workflowVersionId,
        node: input.nodeId,
        scope: input.scope,
      }),
    )
    .digest('hex');
  return { workflowRunId: input.workflowRunId, canonicalScope, invocationKey };
}
