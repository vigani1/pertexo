import { testStepDisposition } from '@pertexo/workflow-engine';
import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import {
  hasCallbackMapping,
  inspectExpression,
} from '@pertexo/workflow-model/server';
import type { NodeAttemptLease } from '@pertexo/core/attempts';
import type { WorkflowExecutionProjection } from '@pertexo/core/runs';
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
} from '../delivery/handler.js';
import {
  type ForEachUpstream,
  type NodeAttemptInputs,
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from '@pertexo/core/execution';

export type NodeAttemptExecutionEngineOptions = Readonly<
  PersistedWorkflowProjectionVerificationOptions & {
    expressionEvaluator?: ExpressionEvaluator;
  }
>;

function ordinal(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
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
          .filter(
            ({ source, target }) =>
              target.nodeId === node.id &&
              source.port !== WORKFLOW_FAILURE_PORT,
          )
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

/** The For Each steps feeding a node, each with its body's last step. */
function deriveForEachUpstreams(
  graph: ExecutableGraph,
  upstream: PreparedNodeAttempt['upstreamNodeOutputs'],
): readonly ForEachUpstream[] {
  return Object.freeze(
    upstream.flatMap(({ nodeId, invocationKey: key }) => {
      const body = graph.nodes.find(({ id }) => id === nodeId)?.structured
        ?.body;
      if (body === undefined) return [];
      const sources = new Set(body.edges.map(({ source }) => source.nodeId));
      const sink = body.nodes.find(({ id }) => !sources.has(id));
      return sink === undefined
        ? []
        : [Object.freeze({ nodeId, invocationKey: key, sinkNodeId: sink.id })];
    }),
  );
}

function prepareNode(
  projection: WorkflowExecutionProjection,
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
  const disposition =
    projection.test === undefined
      ? undefined
      : testStepDisposition(node, projection.test);
  const substituted =
    disposition?.kind === 'pinned' || disposition?.kind === 'pin_required';
  const pinnedSample =
    disposition?.kind === 'pinned' ? projection.testSample : undefined;
  if (disposition?.kind === 'pinned' && pinnedSample === undefined)
    throw new TypeError('Frozen test sample is unavailable');
  const upstreamNodeOutputs = substituted
    ? []
    : deriveUpstreamNodeOutputs(graph, node, lease);
  const sourceFailure = deriveSourceFailure(graph, node, lease);
  // A step that uses a connection sends its input to a provider, and what
  // it sends never enters execution records (ADR 023, 024): only other
  // steps record their input (ADR 052).
  const recordsInput =
    Object.keys(node.connectionRefs).length === 0 &&
    !hasCallbackMapping(node.inputMappings, inspectExpression);
  return Object.freeze({
    ...(substituted ? { testSubstitution: true } : {}),
    ...(disposition?.kind === 'pin_required' ? { testPinRequired: true } : {}),
    ...timedWaitFields(node, projection),
    upstreamNodeOutputs,
    forEachUpstreams: deriveForEachUpstreams(graph, upstreamNodeOutputs),
    ...(sourceFailure === undefined ? {} : { sourceFailure }),
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
      if (input.control.kind === 'abort')
        throw new DOMException('The operation was aborted', 'AbortError');
      if (pinnedSample !== undefined)
        return {
          runId: lease.runId,
          nodeRunId: lease.nodeRunId,
          attemptId: lease.attemptId,
          invocationKey: lease.invocationKey,
          nodeId: node.id,
          kind:
            node.definition.key === 'core.terminate'
              ? ('terminal_success' as const)
              : ('succeeded' as const),
          output: pinnedSample.output,
        };
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
        ...(input.variables === undefined
          ? {}
          : { variables: input.variables }),
        completedNodeOutputs: input.completedNodeOutputs,
        ...(input.sourceFailure === undefined
          ? {}
          : { sourceFailure: input.sourceFailure }),
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
        projection: WorkflowExecutionProjection;
        lease: NodeAttemptLease;
      }>,
    ) => prepareNode(input.projection, input.lease, options),
  });
}

function deriveSourceFailure(
  graph: ExecutableGraph,
  node: WorkflowExecutableNode,
  lease: NodeAttemptLease,
): PreparedNodeAttempt['sourceFailure'] {
  const failureEdge = graph.edges.find(
    ({ source, target }) =>
      source.port === WORKFLOW_FAILURE_PORT && target.nodeId === node.id,
  );
  const sourceFailure =
    failureEdge === undefined
      ? undefined
      : {
          nodeId: failureEdge.source.nodeId,
          invocationKey: invocationKey({
            workflowVersionId: lease.workflowVersionId,
            nodeId: failureEdge.source.nodeId,
            branchPath: (lease.branchPath ?? []).map(
              ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
            ),
            iterationPath: lease.iterationPath ?? [],
          }),
        };

  return sourceFailure;
}

function timedWaitFields(
  node: WorkflowExecutableNode,
  projection: WorkflowExecutionProjection,
): Pick<PreparedNodeAttempt, 'suspensionDurationSeconds'> {
  const timedWait =
    node.definition.key === 'core.wait' &&
    node.definition.version === 1 &&
    node.config.mode !== 'callback' &&
    projection.test === undefined;
  return timedWait
    ? {
        suspensionDurationSeconds: Number(
          Reflect.get(node.config, 'durationSeconds'),
        ),
      }
    : {};
}
