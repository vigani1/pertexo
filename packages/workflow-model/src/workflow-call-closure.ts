import './server-only.js';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json.js';
import {
  workflowCallableGraphSchemaV2,
  type WorkflowCallableGraphV2,
} from './callable-graph-contract.js';
import type { WorkflowGraph, WorkflowNode } from './graph-contract.js';
import { validateWorkflowGraph } from './graph/validation.js';
import { validateExpression } from './expressions.js';
import { parseJsonPath } from './json-path.js';
import {
  WORKFLOW_CALL_FAMILY_POLICY_V1,
  workflowCallPinSchemaV1,
  type WorkflowCallPinV1,
} from './workflow-call-contract.js';

export class WorkflowCallClosureError extends TypeError {
  public constructor(
    readonly code:
      | 'invalid_graph'
      | 'invalid_pin'
      | 'missing_version'
      | 'pin_mismatch'
      | 'not_callable'
      | 'recursive_call'
      | 'depth_limit'
      | 'child_limit'
      | 'expansion_limit',
  ) {
    super(`Workflow call closure is invalid: ${code}`);
    this.name = 'WorkflowCallClosureError';
  }
}

/** Compatibility projection for existing structural/port/loop rules only. */
export function workflowCallStructuralProjectionV1(
  graph: WorkflowGraph,
): WorkflowGraph {
  function nodeProjection(node: WorkflowNode): WorkflowNode {
    if (node.structured === undefined) return node;
    const body = node.structured.body;
    return {
      ...node,
      structured: {
        ...node.structured,
        body: {
          ...workflowCallStructuralProjectionV1(body),
          inputPorts: body.inputPorts,
          outputPorts: body.outputPorts,
        },
      },
    };
  }
  return {
    schemaVersion: 1,
    nodes: graph.nodes.map(nodeProjection),
    edges: graph.edges,
    settings: graph.settings,
  };
}

export function workflowCallableContractIdentityV1(input: unknown): string {
  const declaration = workflowCallableGraphSchemaV2.parse({
    schemaVersion: 2,
    nodes: [],
    edges: [],
    settings: {},
    callable: input,
  }).callable;
  if (declaration === undefined)
    throw new WorkflowCallClosureError('not_callable');
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow-callable-contract.v1',
        declaration,
      }),
    )
    .digest('hex');
  return `callable:v1:sha256:${digest}`;
}

export interface PublishedCallableVersionV1 extends WorkflowCallPinV1 {
  readonly graph: unknown;
}

export interface WorkflowCallClosureV1 {
  readonly expandedInvocations: number;
  readonly childRuns: number;
  readonly maxDepth: number;
  /** Derived pins only. Immutable version graphs remain with their existing owner. */
  readonly dependencies: readonly Readonly<WorkflowCallPinV1>[];
}

/** Apply existing structure/mapping owners to the explicit new source format. */
export function validateWorkflowCallableGraphV2(
  value: unknown,
): WorkflowCallableGraphV2 {
  const parsed = workflowCallableGraphSchemaV2.safeParse(value);
  if (!parsed.success) throw new WorkflowCallClosureError('invalid_graph');
  const graph = parsed.data;
  if (!validateWorkflowGraph(workflowCallStructuralProjectionV1(graph)).ok)
    throw new WorkflowCallClosureError('invalid_graph');
  const selector = graph.callable?.resultSelector;
  if (selector === undefined || selector.kind === 'literal') return graph;
  if (
    selector.kind === 'structured_input' ||
    (selector.kind === 'node_output' &&
      !graph.nodes.some(({ id }) => id === selector.nodeId))
  )
    throw new WorkflowCallClosureError('invalid_graph');
  if (selector.kind === 'expression') {
    if (
      validateExpression(selector.expression, selector.policyVersion).kind !==
      'valid'
    )
      throw new WorkflowCallClosureError('invalid_graph');
  } else if (parseJsonPath(selector.path) === undefined)
    throw new WorkflowCallClosureError('invalid_graph');
  return graph;
}

/**
 * Pure bounded verification over a use-case supplied immutable version index.
 * Resolution may be cached, but each call site/loop product consumes its full
 * worst-case budget. This function performs no I/O or child admission.
 */
export function validateWorkflowCallClosureV1(input: {
  readonly workflowId: string;
  readonly graph: unknown;
  readonly resolve: (
    pin: Readonly<WorkflowCallPinV1>,
  ) => PublishedCallableVersionV1 | undefined;
}): WorkflowCallClosureV1 {
  const rootId = z.uuid().parse(input.workflowId);
  const limits = WORKFLOW_CALL_FAMILY_POLICY_V1;
  const dependencies = new Map<string, Readonly<WorkflowCallPinV1>>();
  const versions = new Map<string, WorkflowCallableGraphV2>();
  let expandedInvocations = 0;
  let childRuns = 0;
  let maxDepth = 0;

  function parseGraph(value: unknown): WorkflowCallableGraphV2 {
    return validateWorkflowCallableGraphV2(value);
  }

  function childGraph(pin: WorkflowCallPinV1): WorkflowCallableGraphV2 {
    const previous = dependencies.get(pin.versionId);
    if (
      previous !== undefined &&
      canonicalJson(previous) !== canonicalJson(pin)
    )
      throw new WorkflowCallClosureError('pin_mismatch');
    const cached = versions.get(pin.versionId);
    if (cached !== undefined) return cached;
    const version = input.resolve(Object.freeze({ ...pin }));
    if (version === undefined)
      throw new WorkflowCallClosureError('missing_version');
    const observed = workflowCallPinSchemaV1.safeParse({
      workflowId: version.workflowId,
      versionId: version.versionId,
      checksum: version.checksum,
      callableContractIdentity: version.callableContractIdentity,
    });
    if (
      !observed.success ||
      canonicalJson(observed.data) !== canonicalJson(pin)
    )
      throw new WorkflowCallClosureError('pin_mismatch');
    const graph = parseGraph(version.graph);
    if (graph.callable === undefined)
      throw new WorkflowCallClosureError('not_callable');
    if (
      workflowCallableContractIdentityV1(graph.callable) !==
      pin.callableContractIdentity
    )
      throw new WorkflowCallClosureError('pin_mismatch');
    dependencies.set(pin.versionId, Object.freeze({ ...pin }));
    versions.set(pin.versionId, graph);
    return graph;
  }

  function walk(
    graph: WorkflowGraph,
    multiplier: number,
    path: readonly string[],
  ): void {
    for (const node of graph.nodes) {
      expandedInvocations += multiplier;
      if (expandedInvocations > limits.maxExpandedInvocations)
        throw new WorkflowCallClosureError('expansion_limit');
      if (node.definition.key === 'core.workflow_call') {
        if (graph.schemaVersion !== 2 || node.definition.version !== 1)
          throw new WorkflowCallClosureError('invalid_pin');
        const parsedPin = workflowCallPinSchemaV1.safeParse(node.config);
        if (!parsedPin.success)
          throw new WorkflowCallClosureError('invalid_pin');
        const pin = parsedPin.data;
        if (path.includes(pin.workflowId))
          throw new WorkflowCallClosureError('recursive_call');
        const depth = path.length;
        if (depth > limits.maxCallDepth)
          throw new WorkflowCallClosureError('depth_limit');
        maxDepth = Math.max(maxDepth, depth);
        childRuns += multiplier;
        if (childRuns > limits.maxChildRuns)
          throw new WorkflowCallClosureError('child_limit');
        walk(childGraph(pin), multiplier, [...path, pin.workflowId]);
      }
      if (node.structured !== undefined)
        walk(
          node.structured.body,
          multiplier * node.structured.maxIterations,
          path,
        );
    }
  }

  walk(parseGraph(input.graph), 1, [rootId]);
  return Object.freeze({
    expandedInvocations,
    childRuns,
    maxDepth,
    dependencies: Object.freeze(
      [...dependencies.values()].sort((left, right) =>
        left.versionId < right.versionId
          ? -1
          : left.versionId > right.versionId
            ? 1
            : 0,
      ),
    ),
  });
}
