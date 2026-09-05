import {
  NodeExecutionAbortedError,
  NodeExecutorFailure,
  type JsonValue as NodeJsonValue,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model/graph';
import {
  resolveValueSource,
  type ValueResolution,
} from '@pertexo/workflow-model/mapping';

import { advanceWorkflowFromSchedulerState } from './advance-workflow.js';
import { WorkflowEngineError } from './errors.js';
import {
  branchSelectionObservations,
  forEachCoordinatorObservations,
  indexPersistedSuccessfulOutcomes,
  mergeCoordinatorObservations,
  parseCompletedOutputItems,
} from './coordinator-observations.js';
import { executableNodes } from './executable-graph.js';
import {
  assertAuthenticExecutableIdentity,
  normalizeBoundedEngineJson,
  type CompiledWorkflowExecutableV2,
  type WorkflowExecutableNodeV2,
  type WorkflowExecutableGraphV2,
} from './executable-workflow.js';
import type { WorkflowObservation } from './types.js';
import { parseCheckpoint } from './checkpoint.js';
import {
  configuredParallelOutputPorts,
  configuredScopedOutputPorts,
  type SchedulerState,
} from './graph-scheduler.js';
import { compareOrdinal } from './ordering.js';
import { branchPathHasPrefix, sameIterationPath } from './scope.js';
import { operationError, record } from './operation-values.js';
import { parsePersistedObservations } from './persisted-observations.js';
import {
  decideRetry,
  providerIdempotencyKey,
  resolveRetryPolicy,
} from './retries.js';
import { invocationKey as createInvocationKey } from './scheduling.js';
import {
  prepareNodeAttemptInput,
  structuredAncestors,
} from './node-attempt-input.js';
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

export function projectSchedulerState(
  graph: WorkflowExecutableGraphV2,
): SchedulerState {
  const projectGraph = (graph: WorkflowExecutableGraphV2): SchedulerState => {
    const nodes = graph.nodes.map(
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
    );
    const edges = graph.edges.map(({ source, target }) => ({
      source: { nodeId: source.nodeId, port: source.port },
      target: { nodeId: target.nodeId, port: target.port },
    }));
    const structuredBodies = graph.nodes.flatMap((node) => {
      if (node.structured === undefined) return [];
      const body = projectGraph(node.structured.body);
      return [
        { loopNodeId: node.id, nodes: body.nodes, edges: body.edges },
        ...(body.structuredBodies ?? []),
      ];
    });
    return { deriveReadiness: true, nodes, edges, structuredBodies };
  };
  return projectGraph(graph);
}

function schedulerState(
  executable: CompiledWorkflowExecutableV2,
): SchedulerState {
  return projectSchedulerState(executable.envelope.graph);
}

function assertCheckpointMatchesExecutable(
  checkpoint: ReturnType<typeof parseCheckpoint>,
  executable: CompiledWorkflowExecutableV2,
  allNodes: readonly WorkflowExecutableNodeV2[],
): void {
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
          sameIterationPath(loop.iterationPath, enclosingPath) &&
          branchPathHasPrefix(branchPath, loop.branchPath),
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
  const executableNodeList = executableNodes(input.executable.envelope.graph);
  const nodesById = new Map(executableNodeList.map((node) => [node.id, node]));
  const invocationsByKey = new Map(
    checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  assertCheckpointMatchesExecutable(
    checkpoint,
    input.executable,
    executableNodeList,
  );
  const persistedObservations = parsePersistedObservations(
    input.observations,
    checkpoint,
  );
  const completedOutputItems = parseCompletedOutputItems(
    input.completedOutputs,
  );
  const successfulOutcomes = indexPersistedSuccessfulOutcomes(
    persistedObservations.facts,
  );
  const branchSelections = branchSelectionObservations(
    completedOutputItems,
    successfulOutcomes,
    checkpoint,
    nodesById,
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
      const invocation = invocationsByKey.get(failure.invocationKey);
      const node = nodesById.get(invocation?.nodeId ?? '');
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
    completedOutputItems,
    persistedObservations.facts,
    successfulOutcomes,
    checkpoint,
    nodesById,
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
    nodesById,
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
    const node = nodesById.get(nodeId);
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
  readonly expressionEvaluator?: ExpressionEvaluator;
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
  expressionEvaluator?: ExpressionEvaluator,
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
        expressionEvaluator,
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
    expressionEvaluator?: ExpressionEvaluator;
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
    input.expressionEvaluator,
    undefined,
  );
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
  const { node, runInput, completedOutputs, directUpstream, structuredInputs } =
    prepareNodeAttemptInput(input);
  const resolvedInput = await resolveMappedNodeInput(
    node.definition.key === 'core.merge' && node.definition.version === 1
      ? { ...node, inputMappings: {} }
      : node,
    runInput,
    completedOutputs,
    directUpstream,
    input.signal,
    input.expressionEvaluator,
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
