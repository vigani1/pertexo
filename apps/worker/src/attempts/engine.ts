import type { NodeAttemptLease } from '@pertexo/database/attempts';
import type { PublishedWorkflow } from '@pertexo/database/runs';
import type {
  ExecuteNodeAttemptInput,
  NodeExecutionRegistry,
} from '@pertexo/workflow-engine';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';
import {
  executeNodeAttempt,
  invocationKey,
  type WorkflowExecutableNode,
} from '@pertexo/workflow-engine';

import type {
  NodeAttemptExecutionEngine,
  PreparedNodeAttempt,
} from './handler.js';
import {
  type NodeAttemptInputs,
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from '@pertexo/execution';

export type NodeAttemptExecutionEngineOptions = Readonly<
  PersistedWorkflowProjectionVerificationOptions & {
    expressionEvaluator?: ExpressionEvaluator;
  }
>;

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type ExecutableGraph = Readonly<{
  nodes: readonly WorkflowExecutableNode[];
  edges: readonly Readonly<{
    source: Readonly<{ nodeId: string; port: string }>;
    target: Readonly<{ nodeId: string; port: string }>;
  }>[];
}>;

function locateNode(
  graph: ExecutableGraph,
  nodeId: string,
):
  | Readonly<{ graph: ExecutableGraph; node: WorkflowExecutableNode }>
  | undefined {
  const node = graph.nodes.find(({ id }) => id === nodeId);
  if (node !== undefined) return { graph, node };
  for (const owner of graph.nodes) {
    if (owner.structured === undefined) continue;
    const found = locateNode(owner.structured.body, nodeId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function deriveUpstreamNodeOutputs(
  graph: ExecutableGraph,
  node: WorkflowExecutableNode,
  lease: NodeAttemptLease,
): PreparedNodeAttempt['upstreamNodeOutputs'] {
  // A Merge takes whichever branch arrived; it has no fixed upstream set.
  if (node.definition.key === 'core.merge' && node.definition.version === 1)
    return Object.freeze([]);
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
  projection: PublishedWorkflow,
  lease: NodeAttemptLease,
  options: NodeAttemptExecutionEngineOptions,
): PreparedNodeAttempt {
  // The engine admitted this lease: its branch path, iteration path,
  // invocation key and side-effect pin are already decided.
  const executable = verifyPersistedWorkflowProjection(projection, options);
  const located = locateNode(executable.envelope.graph, lease.nodeId);
  if (located === undefined)
    throw new TypeError('Node attempt is not in workflow');
  const { graph, node } = located;
  const upstreamNodeOutputs = deriveUpstreamNodeOutputs(graph, node, lease);
  // A step that uses a connection sends its input to a provider, and what
  // it sends never enters execution records (ADR 023, 024): only other
  // steps record their input (ADR 052).
  const recordsInput = Object.keys(node.connectionRefs).length === 0;
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
          onInputResolved?: ExecuteNodeAttemptInput['onInputResolved'];
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
        ...(input.onInputResolved === undefined || !recordsInput
          ? {}
          : { onInputResolved: input.onInputResolved }),
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
        projection: PublishedWorkflow;
        lease: NodeAttemptLease;
      }>,
    ) => prepareNode(input.projection, input.lease, options),
  });
}
