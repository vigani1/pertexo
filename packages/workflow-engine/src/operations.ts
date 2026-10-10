import {
  NodeExecutionAbortedError,
  NodeExecutorFailure,
  type NodeExecutionResult,
} from '@pertexo/node-sdk/server';
import {
  type JsonValue,
  parseWorkflowGraphDraft,
  resolveValueSource,
  type ValueResolution,
} from '@pertexo/workflow-model';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';

import { advanceWorkflowFromSchedulerState } from './transition/advance.js';
import { WorkflowEngineError } from './errors.js';
import { resolveAttemptFailures } from './observation/coordinator-failures.js';
import {
  branchSelectionObservations,
  mergeCoordinatorObservations,
} from './observation/coordinator.js';
import { forEachCoordinatorObservations } from './observation/coordinator-loops.js';
import {
  indexPersistedSuccessfulOutcomes,
  parseCompletedOutputItems,
} from './observation/coordinator-output.js';
import { executableNodes } from './compilation/graph.js';
import {
  assertAuthenticExecutableIdentity,
  type CompiledWorkflowExecutable,
  type WorkflowExecutableNode,
  type WorkflowExecutableGraph,
} from './compilation/foundation.js';
import { normalizeBoundedEngineJson } from './compilation/validation.js';
import type { WorkflowObservation } from './types.js';
import { parseCheckpoint } from './checkpoint/create-and-parse.js';
import type { SchedulerState } from './transition/scheduling/readiness.js';
import { operationError, record } from './operation-values.js';
import { parsePersistedObservations } from './observation/persisted.js';
import { providerIdempotencyKey } from './attempt/retries.js';
import { prepareNodeAttemptInput } from './attempt/input.js';
import type {
  ExecuteNodeAttemptInput,
  NodeAttemptOutcome,
} from './attempt/contract.js';
import type { WorkflowTransitionPlan } from './types.js';
import {
  isCoreMergeDefinition,
  isTriggerSourceDefinition,
} from './core-definition-identities.js';
import { assertCheckpointMatchesExecutable } from './checkpoint/matches-executable.js';

export type {
  ExecuteNodeAttemptInput,
  NodeAttemptOutcome,
  NodeExecutionRegistry,
} from './attempt/contract.js';
export type {
  AttemptFailureObservation,
  DeadlineExpiredObservation,
  DueAtObservation,
  PersistedWorkflowObservation,
} from './observation/persisted.js';

export interface AdvanceWorkflowInput {
  readonly runId: string;
  readonly executable: CompiledWorkflowExecutable;
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
  graph: WorkflowExecutableGraph,
): SchedulerState {
  const projectGraph = (graph: WorkflowExecutableGraph): SchedulerState => {
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
  executable: CompiledWorkflowExecutable,
): SchedulerState {
  return projectSchedulerState(executable.envelope.graph);
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
    invocationsByKey,
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
  const resolvedFailures = resolveAttemptFailures({
    runId: input.runId,
    failures: persistedObservations.attemptFailures,
    invocations: invocationsByKey,
    nodes: nodesById,
    retryPolicyReference: input.executable.envelope.runtimePolicies.retry,
    controlCanceled,
    controlDeadline,
  });
  const forEach = forEachCoordinatorObservations(
    completedOutputItems,
    persistedObservations.facts,
    successfulOutcomes,
    checkpoint,
    invocationsByKey,
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

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    operationError('attempt_aborted', 'node attempt was aborted');
}

function isAbortError(error: unknown): boolean {
  try {
    if (error instanceof NodeExecutionAbortedError) return true;
    if (!(error instanceof Error)) return false;
    return error.name === 'AbortError';
  } catch {
    return false;
  }
}

function isNodeExecutorFailure(error: unknown): error is NodeExecutorFailure {
  try {
    return error instanceof NodeExecutorFailure;
  } catch {
    return false;
  }
}

async function resolveMappedNodeInput(
  node: Pick<WorkflowExecutableNode, 'definition' | 'inputMappings'>,
  runInput: JsonValue,
  completedOutputs: Readonly<Record<string, JsonValue>>,
  directUpstream: ReadonlySet<string>,
  signal: AbortSignal,
  expressionEvaluator?: ExpressionEvaluator,
  structuredInputs?: Readonly<Record<string, JsonValue>>,
): Promise<JsonValue> {
  if (isTriggerSourceDefinition(node.definition)) return runInput;
  const mapped = Object.create(null) as Record<string, JsonValue>;
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
  let node: Pick<WorkflowExecutableNode, 'definition' | 'inputMappings'>;
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
    isCoreMergeDefinition(node.definition)
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
  if (isCoreMergeDefinition(node.definition)) {
    if (input.coordinatorInput === undefined)
      operationError('attempt_invalid', 'settled Merge input is missing');
    try {
      executionInput = normalizeBoundedEngineJson(input.coordinatorInput);
    } catch {
      operationError('attempt_invalid', 'settled Merge input is invalid');
    }
  }
  // Recorded before the executor runs, so failed attempts keep it (ADR 052).
  await input.onInputResolved?.(executionInput);
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
    if (isNodeExecutorFailure(error)) throw error;
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
