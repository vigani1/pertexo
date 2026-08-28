import {
  NodeExecutionAbortedError,
  NodeExecutorFailure,
  type JsonValue as NodeJsonValue,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import {
  canonicalJson,
  type JsonValue,
} from '@pertexo/workflow-model/canonical-json';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model/graph';
import {
  resolveValueSource,
  type ValueResolution,
} from '@pertexo/workflow-model/mapping';

import {
  advanceWorkflowFromSchedulerState,
  type WorkflowObservation,
} from './advance-workflow.js';
import { WorkflowEngineError } from './errors.js';
import {
  branchSelectionObservations,
  forEachCoordinatorObservations,
  mergeCoordinatorObservations,
} from './coordinator-observations.js';
import { executableNodes } from './executable-graph.js';
import {
  assertAuthenticExecutableIdentity,
  normalizeBoundedEngineJson,
  type CompiledWorkflowExecutableV2,
  type WorkflowExecutableNodeV2,
  type WorkflowExecutableGraphV2,
} from './executable-workflow.js';
import { parseCheckpoint } from './checkpoint.js';
import {
  configuredParallelOutputPorts,
  configuredScopedOutputPorts,
  type SchedulerState,
} from './graph-scheduler.js';
import { compareOrdinal } from './ordering.js';
import { exactKeys, operationError, record } from './operation-values.js';
import { parsePersistedObservations } from './persisted-observations.js';
import {
  decideRetry,
  providerIdempotencyKey,
  resolveRetryPolicy,
} from './retries.js';
import { invocationKey as createInvocationKey } from './scheduling.js';
import type {
  BranchScopePart,
  IterationScopePart,
  WorkflowTransitionPlan,
} from './types.js';

export type {
  AttemptFailureObservation,
  DeadlineExpiredObservation,
  DueAtObservation,
  PersistedWorkflowObservation,
} from './persisted-observations.js';

export interface AdvanceWorkflowInput {
  readonly runId: string;
  readonly executable: CompiledWorkflowExecutableV2;
  readonly workflowVersionId: string;
  readonly checkpoint: unknown;
  readonly observations?: unknown;
  readonly completedOutputs?: unknown;
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
  readonly signal: AbortSignal;
}

function assertIdentity(
  value: string,
  label: string,
  code: 'attempt_invalid' | 'workflow_identity_invalid',
): void {
  if (value.length === 0 || value.length > 256)
    operationError(code, `${label} is invalid`);
}

function schedulerState(
  executable: CompiledWorkflowExecutableV2,
): SchedulerState {
  const projectGraph = (graph: WorkflowExecutableGraphV2): SchedulerState => ({
    deriveReadiness: true,
    nodes: graph.nodes.map(
      ({
        id,
        definition,
        config,
        disabled,
        sideEffectClass: pinnedSideEffectClass,
      }) => ({
        id,
        definition,
        config,
        disabled,
        sideEffectClass: pinnedSideEffectClass,
      }),
    ),
    edges: graph.edges.map(({ source, target }) => ({
      source: { nodeId: source.nodeId, port: source.port },
      target: { nodeId: target.nodeId, port: target.port },
    })),
    structuredBodies: graph.nodes.flatMap((node) =>
      node.structured === undefined
        ? []
        : [
            {
              loopNodeId: node.id,
              ...projectGraph(node.structured.body),
            },
            ...(projectGraph(node.structured.body).structuredBodies ?? []),
          ],
    ),
  });
  return projectGraph(executable.envelope.graph);
}

function assertCheckpointMatchesExecutable(
  checkpoint: ReturnType<typeof parseCheckpoint>,
  executable: CompiledWorkflowExecutableV2,
): void {
  const allNodes = executableNodes(executable.envelope.graph);
  const nodeIds = new Set(allNodes.map(({ id }) => id));
  const nodesById = new Map(allNodes.map((node) => [node.id, node]));
  for (const join of checkpoint.joins) {
    const merge = nodesById.get(join.joinId);
    if (
      merge?.definition.key !== 'core.merge' ||
      merge.definition.version !== 1
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint join does not belong to a Merge node',
      );
    const parallelNodeId = Reflect.get(
      merge.config,
      'parallelNodeId',
    ) as unknown;
    const parallel =
      typeof parallelNodeId === 'string'
        ? nodesById.get(parallelNodeId)
        : undefined;
    const branchIds =
      parallel === undefined
        ? undefined
        : configuredParallelOutputPorts(parallel);
    if (branchIds === undefined)
      operationError(
        'workflow_identity_invalid',
        'checkpoint join disagrees with its paired Parallel',
      );
    if (
      join.ledger.length !== branchIds.length ||
      join.ledger.some(({ branchId }) => !branchIds.includes(branchId))
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint join disagrees with its paired Parallel',
      );
    const expectedJoinKey = createInvocationKey({
      workflowVersionId: checkpoint.workflowVersionId,
      nodeId: join.joinId,
      branchPath: (join.branchPath ?? []).map(
        ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
      ),
      ...(join.iterationPath === undefined
        ? {}
        : { iterationPath: join.iterationPath }),
    });
    if (
      join.joinInvocationKey !== expectedJoinKey &&
      !(
        join.joinInvocationKey === join.joinId &&
        (join.branchPath?.length ?? 0) === 0 &&
        (join.iterationPath?.length ?? 0) === 0
      )
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint join scope is invalid',
      );
  }
  const invocationKeys = new Set<string>();
  for (const invocation of checkpoint.invocations) {
    const branchPath = invocation.branchPath ?? [];
    const ancestors = structuredAncestors(
      executable.envelope.graph,
      invocation.nodeId,
    );
    if (
      !nodeIds.has(invocation.nodeId) ||
      ancestors?.length !== (invocation.iterationPath?.length ?? 0) ||
      ancestors.some(
        (loopNodeId, index) =>
          invocation.iterationPath?.[index]?.loopNodeId !== loopNodeId,
      ) ||
      branchPath.some(({ nodeId, outputPort }) => {
        const node = nodesById.get(nodeId);
        const outputPorts =
          node === undefined ? undefined : configuredScopedOutputPorts(node);
        return !outputPorts?.includes(outputPort);
      }) ||
      invocation.invocationKey !==
        createInvocationKey({
          workflowVersionId: checkpoint.workflowVersionId,
          nodeId: invocation.nodeId,
          branchPath: branchPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
          ...(invocation.iterationPath === undefined
            ? {}
            : { iterationPath: invocation.iterationPath }),
        })
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint invocation does not belong to the executable graph',
      );
    for (const [index, scope] of (invocation.iterationPath ?? []).entries()) {
      const enclosingPath = invocation.iterationPath?.slice(0, index) ?? [];
      const declaredLoop = checkpoint.loops.find(
        (loop) =>
          loop.loopId === scope.loopNodeId &&
          JSON.stringify(loop.iterationPath) ===
            JSON.stringify(enclosingPath) &&
          loop.branchPath.every((part, branchIndex) => {
            const invocationPart = branchPath[branchIndex];
            return (
              invocationPart?.nodeId === part.nodeId &&
              invocationPart.outputPort === part.outputPort
            );
          }),
      );
      if (
        declaredLoop === undefined ||
        (!declaredLoop.activeOrdinals.includes(scope.ordinal) &&
          !declaredLoop.terminalOrdinals.includes(scope.ordinal))
      )
        operationError(
          'workflow_identity_invalid',
          'checkpoint invocation iteration scope is not active in its declared loop',
        );
    }
    invocationKeys.add(invocation.invocationKey);
  }
  if (
    checkpoint.admittedInvocationKeys.some(
      (invocationKey) => !invocationKeys.has(invocationKey),
    )
  )
    operationError(
      'workflow_identity_invalid',
      'checkpoint admission does not belong to an executable invocation',
    );
  for (const loop of checkpoint.loops) {
    const node = nodesById.get(loop.loopId);
    if (
      node?.definition.key !== 'core.foreach' ||
      node.definition.version !== 1 ||
      node.structured?.kind !== 'for_each' ||
      loop.controlInvocationKey !==
        createInvocationKey({
          workflowVersionId: checkpoint.workflowVersionId,
          nodeId: loop.loopId,
          branchPath: loop.branchPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
          iterationPath: loop.iterationPath,
        })
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint loop does not belong to its scoped For Each control',
      );
    const body = node.structured.body;
    const targets = new Set(body.edges.map(({ target }) => target.nodeId));
    const sources = new Set(body.edges.map(({ source }) => source.nodeId));
    const expectedRoots = body.nodes
      .map(({ id }) => id)
      .filter((id) => !targets.has(id))
      .sort(compareOrdinal);
    const expectedSink = body.nodes.find(({ id }) => !sources.has(id))?.id;
    if (
      loop.maxIterations !== node.structured.maxIterations ||
      loop.maxConcurrency !== node.structured.maxConcurrency ||
      loop.bodyRootNodeIds.length !== expectedRoots.length ||
      loop.bodyRootNodeIds.some((id, index) => id !== expectedRoots[index]) ||
      loop.bodySinkNodeId !== expectedSink
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint loop topology or bounds disagree with the executable',
      );
  }
}

export async function advanceWorkflow(
  input: AdvanceWorkflowInput,
): Promise<WorkflowTransitionPlan> {
  assertAuthenticExecutableIdentity(input.executable);
  assertIdentity(input.runId, 'runId', 'workflow_identity_invalid');
  assertIdentity(
    input.workflowVersionId,
    'workflowVersionId',
    'workflow_identity_invalid',
  );
  await Promise.resolve();
  assertNotAborted(input.signal);
  const checkpoint = parseCheckpoint(input.checkpoint);
  if (checkpoint.workflowVersionId !== input.workflowVersionId)
    operationError(
      'workflow_identity_invalid',
      'checkpoint workflow version does not match executable identity',
    );
  assertCheckpointMatchesExecutable(checkpoint, input.executable);
  const persistedObservations = parsePersistedObservations(
    input.observations,
    checkpoint,
  );
  const branchSelections = branchSelectionObservations(
    input.completedOutputs,
    input.observations,
    checkpoint,
    input.executable,
  );
  const controlCanceled =
    checkpoint.cancelRequested ||
    persistedObservations.observations.some(
      (observation) => observation.kind === 'cancel_requested',
    );
  const controlDeadline =
    checkpoint.deadlineExpired ||
    persistedObservations.deadlineExpiration !== undefined;
  const retryPolicyReference = input.executable.envelope.runtimePolicies.retry;
  let retryPolicy: ReturnType<typeof resolveRetryPolicy>;
  try {
    retryPolicy = resolveRetryPolicy(retryPolicyReference);
  } catch {
    operationError('workflow_identity_invalid', 'retry policy is unsupported');
  }
  const resolvedFailures: WorkflowObservation[] =
    persistedObservations.attemptFailures.map((failure) => {
      const invocation = checkpoint.invocations.find(
        (candidate) => candidate.invocationKey === failure.invocationKey,
      );
      const node = executableNodes(input.executable.envelope.graph).find(
        (candidate) => candidate.id === invocation?.nodeId,
      );
      if (
        invocation?.status !== 'running' ||
        invocation.attemptNumber !== failure.attemptNumber ||
        node === undefined
      )
        operationError('observation_invalid', 'attempt failure is stale');
      const nonSafeUnknown =
        node.sideEffectClass !== 'safe' && failure.possiblyDispatched;
      if (controlCanceled || controlDeadline) {
        return {
          kind: 'outcome',
          invocationKey: failure.invocationKey,
          status: nonSafeUnknown
            ? 'outcome_unknown'
            : controlCanceled
              ? 'canceled'
              : 'timed_out',
          reasonCode: failure.safeErrorCode,
          coordinatorDerived: true,
        };
      }
      if (failure.failureKind === 'outcome_unknown') {
        return {
          kind: 'outcome',
          invocationKey: failure.invocationKey,
          status: 'outcome_unknown',
          reasonCode: failure.safeErrorCode,
          coordinatorDerived: true,
        };
      }
      if (failure.failureKind === 'canceled') {
        return {
          kind: 'outcome',
          invocationKey: failure.invocationKey,
          status: nonSafeUnknown ? 'outcome_unknown' : 'canceled',
          reasonCode: failure.safeErrorCode,
          coordinatorDerived: true,
        };
      }
      const decision = decideRetry({
        sideEffectClass: node.sideEffectClass,
        currentAttemptNumber: failure.attemptNumber,
        policy: retryPolicy,
        observation: {
          kind: 'executor_failure',
          recommendation: failure.failureKind,
          errorKind: failure.errorKind,
          possiblyDispatched: failure.possiblyDispatched,
        },
        jitterIdentity: `${input.runId}\u0000${failure.invocationKey}\u0000${String(failure.attemptNumber)}\u0000${retryPolicyReference.key}@${String(retryPolicyReference.version)}`,
      });
      if (decision.kind === 'retry') {
        return {
          kind: 'wait',
          invocationKey: failure.invocationKey,
          resumeAt: new Date(
            Date.parse(failure.occurredAt) + decision.delayMs,
          ).toISOString(),
          waitKind: 'retry_backoff',
          coordinatorDerived: true,
        };
      }
      return {
        kind: 'outcome',
        invocationKey: failure.invocationKey,
        status:
          decision.kind === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
        reasonCode: failure.safeErrorCode,
        coordinatorDerived: true,
      };
    });
  const forEach = forEachCoordinatorObservations(
    input.completedOutputs,
    input.observations,
    checkpoint,
    input.executable,
    resolvedFailures,
  );
  const executionObservations = persistedObservations.observations.map(
    (observation): WorkflowObservation =>
      observation.kind === 'outcome' &&
      forEach.declarationInvocationKeys.has(observation.invocationKey)
        ? { kind: 'cursor_only' }
        : observation,
  );
  const coordinatorObservations = mergeCoordinatorObservations(
    input.executable,
    checkpoint,
    [...executionObservations, ...resolvedFailures],
  );
  const plan = advanceWorkflowFromSchedulerState({
    checkpoint,
    schedulerState: schedulerState(input.executable),
    observations: [
      ...executionObservations,
      ...branchSelections,
      ...resolvedFailures,
      ...forEach.observations,
      ...coordinatorObservations,
    ],
    ...(persistedObservations.deadlineExpiration === undefined
      ? {}
      : {
          deadlineExpiration: {
            occurredAt: persistedObservations.deadlineExpiration.occurredAt,
          },
        }),
    persistedObservationCursor: persistedObservations.cursor,
    dueResumptions: persistedObservations.dueResumptions,
    occurredAt: input.occurredAt,
    maximumAdmissions: input.maximumAdmissions,
  });
  assertNotAborted(input.signal);
  const providerKey = (
    nodeId: string,
    invocationKey: string,
  ): string | undefined => {
    const node = executableNodes(input.executable.envelope.graph).find(
      (candidate) => candidate.id === nodeId,
    );
    if (node?.sideEffectClass !== 'idempotent_with_key') return undefined;
    return providerIdempotencyKey({
      invocationKey,
      namespace: 'pertexo.node-attempt',
      operationIdentity: `${node.definition.key}@${String(node.definition.version)}`,
      runId: input.runId,
    });
  };
  return Object.freeze({
    ...plan,
    attempts: plan.attempts.map((attempt) => {
      const key = providerKey(attempt.nodeId, attempt.invocationKey);
      return Object.freeze({
        ...attempt,
        ...(key === undefined ? {} : { providerIdempotencyKey: key }),
      });
    }),
    nodeRunAdmissions: plan.nodeRunAdmissions.map((admission) => {
      const key = providerKey(admission.nodeId, admission.invocationKey);
      return Object.freeze({
        ...admission,
        ...(key === undefined ? {} : { providerIdempotencyKey: key }),
      });
    }),
  });
}

export interface NodeExecutionRegistry {
  readonly execute: (
    request: NodeExecutionRequest,
  ) => Promise<NodeExecutionResult>;
  readonly dispatchMode?: (
    request: Pick<NodeExecutionRequest, 'definition' | 'executor'>,
  ) => 'before_execute' | 'executor_controlled';
}

export interface ExecuteNodeAttemptInput {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attemptId: string;
  readonly executable: CompiledWorkflowExecutableV2;
  readonly workflowVersionId: string;
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly branchPath?: readonly BranchScopePart[];
  readonly iterationPath?: readonly IterationScopePart[];
  readonly structuredCollection?: Readonly<{
    readonly loopNodeId: string;
    readonly ordinal: number;
    readonly collection: unknown;
    readonly collectionSize: number;
    readonly declaredCollectionChecksum: string;
  }>;
  readonly runInput: unknown;
  readonly completedNodeOutputs: unknown;
  readonly coordinatorInput?: unknown;
  readonly registry: NodeExecutionRegistry;
  readonly signal: AbortSignal;
  readonly runtime?: NodeExecutionRuntime;
}

export interface NodeAttemptOutcome {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attemptId: string;
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly kind: NodeExecutionResult['kind'];
  readonly output: NodeJsonValue;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    operationError('attempt_aborted', 'node attempt was aborted');
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof NodeExecutionAbortedError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

const TRIGGER_SOURCE_IDENTITIES = new Set([
  'core.manual@1',
  'core.schedule@1',
  'core.webhook@1',
]);

async function resolveMappedNodeInput(
  node: Pick<WorkflowExecutableNodeV2, 'definition' | 'inputMappings'>,
  runInput: JsonValue,
  completedOutputs: Readonly<Record<string, JsonValue>>,
  directUpstream: ReadonlySet<string>,
  signal: AbortSignal,
  structuredInputs?: Readonly<Record<string, JsonValue>>,
): Promise<JsonValue> {
  if (
    TRIGGER_SOURCE_IDENTITIES.has(
      `${node.definition.key}@${String(node.definition.version)}`,
    )
  )
    return runInput;
  const mapped: Record<string, JsonValue> = {};
  for (const key of Object.keys(node.inputMappings).sort()) {
    assertNotAborted(signal);
    const source = node.inputMappings[key];
    if (source === undefined) continue;
    if (
      source.kind === 'node_output' &&
      (!directUpstream.has(source.nodeId) ||
        !Object.hasOwn(completedOutputs, source.nodeId))
    )
      operationError(
        'attempt_invalid',
        'mapping upstream output is incomplete',
      );
    let resolution: ValueResolution;
    try {
      resolution = await resolveValueSource(
        source,
        {
          runInput,
          nodeOutputs: completedOutputs,
          ...(structuredInputs === undefined ? {} : { structuredInputs }),
        },
        undefined,
        signal,
      );
    } catch (error) {
      if (signal.aborted || isAbortError(error))
        operationError('attempt_aborted', 'node attempt was aborted');
      operationError('attempt_invalid', 'mapping failed');
    }
    if (
      resolution.kind === 'error' &&
      (resolution.expression?.code === 'canceled' || signal.aborted)
    )
      operationError('attempt_aborted', 'node attempt was aborted');
    if (resolution.kind === 'error')
      operationError('attempt_invalid', 'mapping resolution failed');
    if (resolution.kind === 'value') mapped[key] = resolution.value;
  }
  try {
    return normalizeBoundedEngineJson(mapped);
  } catch {
    operationError('attempt_invalid', 'mapped input exceeds runtime limits');
  }
}

/** Resolve one isolated preview node through the production ValueSource path. */
export async function resolveSingleNodePreviewInput(
  input: Readonly<{
    node: unknown;
    runInput: unknown;
    signal: AbortSignal;
  }>,
): Promise<JsonValue> {
  let node: Pick<WorkflowExecutableNodeV2, 'definition' | 'inputMappings'>;
  let runInput: JsonValue;
  try {
    runInput = normalizeBoundedEngineJson(input.runInput);
    const rawNode = record(
      normalizeBoundedEngineJson(input.node),
      'attempt_invalid',
      'preview node',
    );
    const parsedNode = parseWorkflowGraphDraft({
      edges: [],
      nodes: [{ ...rawNode, position: { x: 0, y: 0 } }],
      schemaVersion: 1,
      settings: {},
    }).nodes[0];
    if (parsedNode === undefined)
      operationError('attempt_invalid', 'preview node is missing');
    node = parsedNode;
  } catch (error) {
    if (error instanceof WorkflowEngineError) throw error;
    operationError(
      'attempt_invalid',
      error instanceof Error ? error.message : 'preview input is invalid',
    );
  }
  return resolveMappedNodeInput(
    node,
    runInput,
    Object.freeze({}),
    new Set(),
    input.signal,
    undefined,
  );
}

function graphContainingNode(
  graph: WorkflowExecutableGraphV2,
  nodeId: string,
): WorkflowExecutableGraphV2 | undefined {
  if (graph.nodes.some(({ id }) => id === nodeId)) return graph;
  for (const node of graph.nodes) {
    if (node.structured === undefined) continue;
    const found = graphContainingNode(node.structured.body, nodeId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function structuredAncestors(
  graph: WorkflowExecutableGraphV2,
  nodeId: string,
  ancestors: readonly string[] = [],
): readonly string[] | undefined {
  if (graph.nodes.some(({ id }) => id === nodeId)) return ancestors;
  for (const node of graph.nodes) {
    if (node.structured === undefined) continue;
    const found = structuredAncestors(node.structured.body, nodeId, [
      ...ancestors,
      node.id,
    ]);
    if (found !== undefined) return found;
  }
  return undefined;
}

export async function executeNodeAttempt(
  input: ExecuteNodeAttemptInput,
): Promise<NodeAttemptOutcome> {
  assertAuthenticExecutableIdentity(input.executable);
  assertIdentity(input.runId, 'runId', 'attempt_invalid');
  assertIdentity(input.nodeRunId, 'nodeRunId', 'attempt_invalid');
  assertIdentity(input.attemptId, 'attemptId', 'attempt_invalid');
  assertIdentity(
    input.workflowVersionId,
    'workflowVersionId',
    'attempt_invalid',
  );
  assertNotAborted(input.signal);
  let runInput: JsonValue;
  let completed: JsonValue;
  try {
    runInput = normalizeBoundedEngineJson(input.runInput);
    completed = normalizeBoundedEngineJson(input.completedNodeOutputs);
  } catch (error) {
    operationError(
      'attempt_invalid',
      error instanceof Error ? error.message : 'attempt input is invalid',
    );
  }
  const node = executableNodes(input.executable.envelope.graph).find(
    ({ id }) => id === input.nodeId,
  );
  if (node === undefined || node.disabled)
    operationError('attempt_invalid', 'node is not executable');
  const ancestors = structuredAncestors(
    input.executable.envelope.graph,
    node.id,
  );
  if (
    ancestors?.length !== (input.iterationPath?.length ?? 0) ||
    ancestors.some(
      (loopNodeId, index) =>
        input.iterationPath?.[index]?.loopNodeId !== loopNodeId,
    )
  )
    operationError(
      'attempt_invalid',
      'node invocation structured scope does not match the executable',
    );
  if (
    input.invocationKey !==
    createInvocationKey({
      workflowVersionId: input.workflowVersionId,
      nodeId: node.id,
      ...(input.branchPath === undefined
        ? {}
        : {
            branchPath: input.branchPath.map(
              ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
            ),
          }),
      ...(input.iterationPath === undefined
        ? {}
        : { iterationPath: input.iterationPath }),
    })
  )
    operationError(
      'attempt_invalid',
      'node invocation identity does not match',
    );
  const containingGraph = graphContainingNode(
    input.executable.envelope.graph,
    node.id,
  );
  if (containingGraph === undefined)
    operationError('attempt_invalid', 'node graph is missing');
  const directUpstream = new Set(
    containingGraph.edges
      .filter(({ target }) => target.nodeId === node.id)
      .map(({ source }) => source.nodeId),
  );
  const completedOutputs: Record<string, JsonValue> = {};
  if (Array.isArray(completed)) {
    for (const candidate of completed as readonly JsonValue[]) {
      const descriptor = record(
        candidate,
        'attempt_invalid',
        'completed output',
      );
      exactKeys(
        descriptor,
        ['invocationKey', 'nodeId', 'value'],
        [],
        'attempt_invalid',
      );
      const upstreamEdge = containingGraph.edges.find(
        ({ source, target }) =>
          source.nodeId === descriptor.nodeId && target.nodeId === node.id,
      );
      const branchPath = input.branchPath ?? [];
      const nearestBranch = branchPath.at(-1);
      const upstreamBranchPath =
        upstreamEdge !== undefined &&
        nearestBranch?.nodeId === descriptor.nodeId &&
        nearestBranch?.outputPort === upstreamEdge.source.port
          ? branchPath.slice(0, -1)
          : branchPath;
      if (
        typeof descriptor.nodeId !== 'string' ||
        typeof descriptor.invocationKey !== 'string' ||
        !directUpstream.has(descriptor.nodeId) ||
        upstreamEdge === undefined ||
        descriptor.invocationKey !==
          createInvocationKey({
            workflowVersionId: input.workflowVersionId,
            nodeId: descriptor.nodeId,
            branchPath: upstreamBranchPath.map(
              ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
            ),
            ...(input.iterationPath === undefined
              ? {}
              : { iterationPath: input.iterationPath }),
          })
      )
        operationError(
          'attempt_invalid',
          'completed output invocation is not exact upstream',
        );
      if (descriptor.value === undefined)
        operationError('attempt_invalid', 'completed output value is missing');
      completedOutputs[descriptor.nodeId] = descriptor.value;
    }
  } else {
    if ((input.iterationPath?.length ?? 0) > 0)
      operationError(
        'attempt_invalid',
        'scoped completed outputs require invocation descriptors',
      );
    const legacy = record(completed, 'attempt_invalid', 'completed outputs');
    for (const [nodeId, value] of Object.entries(legacy)) {
      if (!directUpstream.has(nodeId))
        operationError(
          'attempt_invalid',
          'completed output is not direct upstream',
        );
      completedOutputs[nodeId] = value;
    }
  }
  let structuredInputs: Readonly<Record<string, JsonValue>> | undefined;
  if (input.iterationPath !== undefined) {
    const nearest = input.iterationPath.at(-1);
    const proof = input.structuredCollection;
    if (proof === undefined || nearest === undefined)
      operationError(
        'attempt_invalid',
        'structured collection proof is missing',
      );
    let collection: JsonValue;
    try {
      collection = normalizeBoundedEngineJson(proof.collection);
    } catch {
      operationError('attempt_invalid', 'structured collection is invalid');
    }
    if (!Array.isArray(collection))
      operationError(
        'attempt_invalid',
        'structured collection must be an array',
      );
    const items = collection as readonly JsonValue[];
    if (
      proof.loopNodeId !== nearest.loopNodeId ||
      !Number.isSafeInteger(proof.ordinal) ||
      proof.ordinal !== nearest.ordinal ||
      !Number.isSafeInteger(proof.collectionSize) ||
      proof.collectionSize !== items.length ||
      nearest.ordinal < 0 ||
      nearest.ordinal >= items.length ||
      typeof proof.declaredCollectionChecksum !== 'string' ||
      createHash('sha256').update(canonicalJson(items)).digest('hex') !==
        proof.declaredCollectionChecksum
    )
      operationError(
        'attempt_invalid',
        'structured collection proof is invalid',
      );
    const item: JsonValue | undefined = items[nearest.ordinal];
    if (item === undefined)
      operationError(
        'attempt_invalid',
        'structured collection item is missing',
      );
    structuredInputs = { item, ordinal: nearest.ordinal };
  }
  const resolvedInput = await resolveMappedNodeInput(
    node.definition.key === 'core.merge' && node.definition.version === 1
      ? { ...node, inputMappings: {} }
      : node,
    runInput,
    completedOutputs,
    directUpstream,
    input.signal,
    structuredInputs,
  );
  let executionInput = resolvedInput;
  if (node.definition.key === 'core.merge' && node.definition.version === 1) {
    if (input.coordinatorInput === undefined)
      operationError('attempt_invalid', 'settled Merge input is missing');
    try {
      executionInput = normalizeBoundedEngineJson(input.coordinatorInput);
    } catch {
      operationError('attempt_invalid', 'settled Merge input is invalid');
    }
  }
  assertNotAborted(input.signal);
  let result: NodeExecutionResult;
  try {
    result = await input.registry.execute({
      definition: node.definition,
      executor: node.executor,
      config: node.config,
      input: executionInput,
      connectionRefs: node.connectionRefs,
      signal: input.signal,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    });
  } catch (error) {
    if (input.signal.aborted || isAbortError(error))
      operationError('attempt_aborted', 'node attempt was aborted');
    if (error instanceof NodeExecutorFailure) throw error;
    operationError('attempt_invalid', 'node execution failed');
  }
  return {
    runId: input.runId,
    nodeRunId: input.nodeRunId,
    attemptId: input.attemptId,
    invocationKey: input.invocationKey,
    nodeId: node.id,
    kind: result.kind,
    output: result.output,
  };
}
import { createHash } from 'node:crypto';
