import type {
  NodeAttemptInputs,
  NodeAttemptLease,
  PublishedWorkflowV2Projection,
} from '@pertexo/database/execution';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';
import {
  executeNodeAttempt,
  invocationKey,
  type WorkflowExecutableNodeV2,
} from '@pertexo/workflow-engine';

import type {
  NodeAttemptExecutionEngine,
  PreparedNodeAttempt,
} from './node-attempt-handler.js';
import {
  isWorkerCoreMergeDefinition,
  isWorkerCoreParallelDefinition,
} from './core-definition-identities.js';
import {
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from './persisted-workflow-projection.js';

export type NodeAttemptExecutionEngineOptions = Readonly<
  PersistedWorkflowProjectionVerificationOptions & {
    expressionEvaluator?: ExpressionEvaluator;
  }
>;

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type ExecutableGraph = Readonly<{
  nodes: readonly WorkflowExecutableNodeV2[];
  edges: readonly Readonly<{
    source: Readonly<{ nodeId: string; port: string }>;
    target: Readonly<{ nodeId: string; port: string }>;
  }>[];
}>;

type ExecutableScope = Readonly<{
  graph: ExecutableGraph;
  targetNodeId: string;
}>;

type LocatedExecutableNode = Readonly<{
  graph: ExecutableGraph;
  node: WorkflowExecutableNodeV2;
  iterationAncestors: readonly string[];
  scopes: readonly ExecutableScope[];
}>;

function locateNode(
  graph: ExecutableGraph,
  nodeId: string,
  iterationAncestors: readonly string[] = [],
  scopes: readonly ExecutableScope[] = [],
): LocatedExecutableNode | undefined {
  const node = graph.nodes.find(({ id }) => id === nodeId);
  if (node !== undefined)
    return {
      graph,
      node,
      iterationAncestors,
      scopes: [...scopes, { graph, targetNodeId: node.id }],
    };
  for (const owner of graph.nodes) {
    if (owner.structured === undefined) continue;
    const found = locateNode(
      owner.structured.body,
      nodeId,
      [...iterationAncestors, owner.id],
      [...scopes, { graph, targetNodeId: owner.id }],
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

function scopedOutputPorts(
  node: WorkflowExecutableNodeV2,
): readonly string[] | undefined {
  if (node.definition.key === 'core.condition' && node.definition.version === 1)
    return ['false', 'true'];
  if (node.definition.key === 'core.switch' && node.definition.version === 1) {
    const cases = Reflect.get(node.config, 'cases') as unknown;
    if (!Array.isArray(cases)) return undefined;
    const ports = cases.map((item): unknown =>
      typeof item === 'object' && item !== null
        ? Reflect.get(item, 'id')
        : undefined,
    );
    return ports.every((port) => typeof port === 'string')
      ? [...ports, 'default']
      : undefined;
  }
  if (isWorkerCoreParallelDefinition(node.definition)) {
    const branches = Reflect.get(node.config, 'branches') as unknown;
    if (!Array.isArray(branches)) return undefined;
    const ports = branches.map((item): unknown =>
      typeof item === 'object' && item !== null
        ? Reflect.get(item, 'id')
        : undefined,
    );
    return ports.every((port) => typeof port === 'string') ? ports : undefined;
  }
  return undefined;
}

function branchReachesTarget(
  graph: ExecutableGraph,
  branchNodeId: string,
  outputPort: string,
  targetNodeId: string,
): boolean {
  const pending = graph.edges
    .filter(
      ({ source }) =>
        source.nodeId === branchNodeId && source.port === outputPort,
    )
    .map(({ target }) => target.nodeId);
  const reached = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || reached.has(nodeId)) continue;
    if (nodeId === targetNodeId) return true;
    reached.add(nodeId);
    const node = graph.nodes.find(({ id }) => id === nodeId);
    if (isWorkerCoreMergeDefinition(node?.definition)) continue;
    pending.push(
      ...graph.edges
        .filter(({ source }) => source.nodeId === nodeId)
        .map(({ target }) => target.nodeId),
    );
  }
  return false;
}

function assertProjectionIdentity(
  projection: PublishedWorkflowV2Projection,
  lease: NodeAttemptLease,
): void {
  if (projection.id !== lease.workflowVersionId)
    throw new TypeError(
      'Node attempt workflow version identity does not match',
    );
}

function validateExecutableScope(
  located: LocatedExecutableNode,
  lease: NodeAttemptLease,
): void {
  const { iterationAncestors, scopes } = located;
  if (
    iterationAncestors.length !== (lease.iterationPath?.length ?? 0) ||
    iterationAncestors.some(
      (loopNodeId, index) =>
        lease.iterationPath?.[index]?.loopNodeId !== loopNodeId,
    )
  )
    throw new TypeError(
      'Node attempt structured scope does not match its executable ancestry',
    );
  const expectedBranchPath = scopes.flatMap(({ graph, targetNodeId }) => {
    const target = graph.nodes.find(({ id }) => id === targetNodeId);
    if (isWorkerCoreMergeDefinition(target?.definition)) return [];
    const branches = graph.nodes.flatMap((branchNode) => {
      const reachingPorts = (scopedOutputPorts(branchNode) ?? []).filter(
        (outputPort) =>
          branchReachesTarget(graph, branchNode.id, outputPort, targetNodeId),
      );
      if (reachingPorts.length === 0) return [];
      const [reachingPort] = reachingPorts;
      if (reachingPorts.length !== 1 || reachingPort === undefined)
        throw new TypeError(
          'Node attempt branch ancestry is ambiguous in its executable graph',
        );
      return [{ nodeId: branchNode.id, outputPort: reachingPort }];
    });
    return branches.sort((left, right) => {
      if (
        branchReachesTarget(graph, left.nodeId, left.outputPort, right.nodeId)
      )
        return -1;
      if (
        branchReachesTarget(graph, right.nodeId, right.outputPort, left.nodeId)
      )
        return 1;
      return ordinal(left.nodeId, right.nodeId);
    });
  });
  const branchPath = lease.branchPath ?? [];
  if (
    branchPath.length !== expectedBranchPath.length ||
    !expectedBranchPath.every((part, index) => {
      const actual = branchPath.at(index);
      return (
        part.nodeId === actual?.nodeId && part.outputPort === actual.outputPort
      );
    })
  )
    throw new TypeError(
      'Node attempt branch scope does not match its executable ancestry',
    );
}

function assertLeasePins(
  node: WorkflowExecutableNodeV2,
  lease: NodeAttemptLease,
): void {
  const expectedInvocationKey = invocationKey({
    workflowVersionId: lease.workflowVersionId,
    nodeId: lease.nodeId,
    branchPath: (lease.branchPath ?? []).map(
      ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
    ),
    ...(lease.iterationPath === undefined
      ? {}
      : { iterationPath: lease.iterationPath }),
  });
  if (lease.invocationKey !== expectedInvocationKey)
    throw new TypeError('Node attempt invocation scope is not authentic');
  if (node.sideEffectClass !== lease.sideEffectClass)
    throw new TypeError(
      'Node attempt side-effect class does not match its pin',
    );
}

function deriveUpstreamNodeOutputs(
  graph: ExecutableGraph,
  node: WorkflowExecutableNodeV2,
  lease: NodeAttemptLease,
): PreparedNodeAttempt['upstreamNodeOutputs'] {
  if (isWorkerCoreMergeDefinition(node.definition)) return Object.freeze([]);
  return Object.freeze(
    [
      ...new Map(
        graph.edges
          .filter(({ target }) => target.nodeId === node.id)
          .map((edge) => [edge.source.nodeId, edge]),
      ).values(),
    ]
      .sort((left, right) => ordinal(left.source.nodeId, right.source.nodeId))
      .map((edge) => {
        const branchPath = lease.branchPath ?? [];
        const nearestBranch = branchPath.at(-1);
        const sourceBranchPath =
          nearestBranch?.nodeId === edge.source.nodeId &&
          nearestBranch.outputPort === edge.source.port
            ? branchPath.slice(0, -1)
            : branchPath;
        return Object.freeze({
          nodeId: edge.source.nodeId,
          invocationKey: invocationKey({
            workflowVersionId: lease.workflowVersionId,
            nodeId: edge.source.nodeId,
            branchPath: sourceBranchPath.map(
              ({ nodeId: branchNodeId, outputPort }) =>
                `${branchNodeId}:${outputPort}`,
            ),
            ...(lease.iterationPath === undefined
              ? {}
              : { iterationPath: lease.iterationPath }),
          }),
        });
      }),
  );
}

function prepareNode(
  projection: PublishedWorkflowV2Projection,
  lease: NodeAttemptLease,
  options: NodeAttemptExecutionEngineOptions,
): PreparedNodeAttempt {
  assertProjectionIdentity(projection, lease);
  const executable = verifyPersistedWorkflowProjection(projection, options);
  const located = locateNode(executable.envelope.graph, lease.nodeId);
  if (located === undefined)
    throw new TypeError('Node attempt is not in workflow');
  validateExecutableScope(located, lease);
  assertLeasePins(located.node, lease);
  const upstreamNodeOutputs = deriveUpstreamNodeOutputs(
    located.graph,
    located.node,
    lease,
  );
  const { node } = located;
  return Object.freeze({
    ...(node.definition.key === 'core.wait' && node.definition.version === 1
      ? {
          suspensionDurationSeconds: Number(
            Reflect.get(node.config, 'durationSeconds'),
          ),
        }
      : {}),
    upstreamNodeOutputs,
    execute: async (
      input: Readonly<
        NodeAttemptInputs & {
          registry: NodeExecutionRegistry;
          runtime?: NodeExecutionRuntime;
          signal: AbortSignal;
        }
      >,
    ) => {
      if (input.abortRequested)
        throw new DOMException('The operation was aborted', 'AbortError');
      return executeNodeAttempt({
        runId: lease.runId,
        nodeRunId: lease.nodeRunId,
        attemptId: lease.attemptId,
        executable,
        workflowVersionId: lease.workflowVersionId,
        invocationKey: lease.invocationKey,
        nodeId: lease.nodeId,
        ...(lease.branchPath === undefined
          ? {}
          : { branchPath: lease.branchPath }),
        ...(lease.iterationPath === undefined
          ? {}
          : { iterationPath: lease.iterationPath }),
        runInput: input.runInput,
        completedNodeOutputs: input.completedNodeOutputs,
        ...(input.structuredCollection === undefined
          ? {}
          : { structuredCollection: input.structuredCollection }),
        ...(input.coordinatorInput === undefined
          ? {}
          : { coordinatorInput: input.coordinatorInput }),
        registry: input.registry,
        ...(options.expressionEvaluator === undefined
          ? {}
          : { expressionEvaluator: options.expressionEvaluator }),
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        signal: input.signal,
      });
    },
  });
}

export function createNodeAttemptExecutionEngine(
  options: NodeAttemptExecutionEngineOptions,
): NodeAttemptExecutionEngine {
  return Object.freeze({
    prepare: (
      input: Readonly<{
        projection: PublishedWorkflowV2Projection;
        lease: NodeAttemptLease;
      }>,
    ) => prepareNode(input.projection, input.lease, options),
  });
}
