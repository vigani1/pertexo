import type { WorkflowTestPolicy } from './testing/policy.js';
import {
  testStepDisposition,
  applyWorkflowTestPolicy,
} from './testing/policy.js';
import {
  isHumanTaskDefinition,
  isWorkflowCallDefinition,
} from '@pertexo/workflow-model';
import {
  isWorkflowTriggerDefinition,
  workspaceVariableValuesSchema,
  type WorkspaceVariableValues,
} from '@pertexo/workflow-model';
import {
  taskDeclarationObservations,
  taskOutcomeObservations,
} from './observation/coordinator-tasks.js';
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
  type WorkflowNodeFailureValue,
} from '@pertexo/workflow-model';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';

import { advanceWorkflowFromSchedulerState } from './transition/advance.js';
import { WorkflowEngineError } from './errors.js';
import { resolveAttemptFailures } from './observation/coordinator-failures.js';
import {
  branchSelectionObservations,
  mergeCoordinatorObservations,
} from './observation/coordinator.js';
import {
  callDeclarationObservations,
  callOutcomeObservations,
} from './observation/coordinator-calls.js';
import { forEachCoordinatorObservations } from './observation/coordinator-loops.js';
import {
  indexPersistedSuccessfulOutcomes,
  parseCompletedOutputItems,
} from './observation/coordinator-output.js';
import { executableNodes } from './compilation/graph.js';
import {
  assertAuthenticExecutableIdentity,
  executableFailureRoutes,
  type CompiledWorkflowExecutable,
  type WorkflowExecutableNode,
  type WorkflowExecutableGraph,
} from './compilation/foundation.js';
import {
  normalizeBoundedEngineJson,
  normalizeBoundedEngineValue,
} from './compilation/validation.js';
import type { WorkflowObservation } from './types.js';
import { parseCheckpoint } from './checkpoint/create-and-parse.js';
import type { SchedulerState } from './transition/scheduling/readiness.js';
import { operationError, record } from './operation-values.js';
import { parsePersistedObservations } from './observation/persisted.js';
import { nodeProviderIdempotencyKey } from './attempt/derive-provider-key.js';
import { prepareNodeAttemptInput } from './attempt/input.js';
import type {
  ExecuteNodeAttemptInput,
  NodeAttemptOutcome,
} from './attempt/contract.js';
import type { WorkflowTransitionPlan } from './types.js';
import { isCoreMergeDefinition } from './core-definition-identities.js';
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
  readonly test?: WorkflowTestPolicy;
  readonly runId: string;
  readonly executable: CompiledWorkflowExecutable;
  readonly workflowVersionId: string;
  readonly checkpoint: unknown;
  readonly observations?: unknown;
  readonly completedOutputs?: unknown;
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
  readonly hasExecutionSlot?: boolean;
  readonly callOutcomes?: unknown;
  readonly taskOutcomes?: unknown;
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
  const routes = executableFailureRoutes(executable);
  return {
    ...projectSchedulerState(executable.envelope.graph),
    ...(routes.length === 0 ? {} : { failureRoutes: routes }),
  };
}

export async function advanceWorkflow(
  input: AdvanceWorkflowInput,
): Promise<WorkflowTransitionPlan> {
  assertAuthenticExecutableIdentity(input.executable);
  if (
    input.hasExecutionSlot !== undefined &&
    typeof input.hasExecutionSlot !== 'boolean'
  )
    operationError(
      'observation_invalid',
      'execution slot availability is invalid',
    );
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
  const test = input.test;
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
    input.test !== undefined,
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
  // Test human/Call outputs are final samples, never declarations of work.
  const declarationNodes =
    test === undefined
      ? nodesById
      : new Map(
          [...nodesById].filter(
            ([, node]) =>
              !isHumanTaskDefinition(node.definition) &&
              !isWorkflowCallDefinition(node.definition),
          ),
        );
  const calls = callDeclarationObservations(
    successfulOutcomes,
    checkpoint,
    declarationNodes,
  );
  const callOutcomes = callOutcomeObservations(
    input.callOutcomes,
    checkpoint,
    nodesById,
    input.executable.envelope.graph,
  );
  const tasks = taskDeclarationObservations(
    completedOutputItems,
    successfulOutcomes,
    invocationsByKey,
    declarationNodes,
  );
  const taskOutcomes = taskOutcomeObservations(
    input.taskOutcomes,
    checkpoint,
    nodesById,
    input.executable.envelope.graph,
  );
  const forEach = forEachCoordinatorObservations(
    completedOutputItems,
    persistedObservations.facts.filter((fact) => {
      const value = record(fact, 'observation_invalid', 'persisted fact');
      return (
        value.kind !== 'outcome' ||
        (!calls.declarationInvocationKeys.has(value.invocationKey as string) &&
          !tasks.declarationInvocationKeys.has(value.invocationKey as string))
      );
    }),
    successfulOutcomes,
    checkpoint,
    invocationsByKey,
    test === undefined
      ? nodesById
      : new Map(
          [...nodesById].filter(
            ([, node]) =>
              node.structured === undefined ||
              testStepDisposition(node, test).kind !== 'pinned',
          ),
        ),
    [...resolvedFailures, ...callOutcomes, ...taskOutcomes],
  );
  const executionObservations = persistedObservations.observations.map(
    (observation): WorkflowObservation =>
      observation.kind === 'outcome' &&
      (forEach.declarationInvocationKeys.has(observation.invocationKey) ||
        calls.declarationInvocationKeys.has(observation.invocationKey) ||
        tasks.declarationInvocationKeys.has(observation.invocationKey))
        ? { kind: 'cursor_only' }
        : observation,
  );
  const coordinatorObservations = mergeCoordinatorObservations(
    input.executable,
    checkpoint,
    [
      ...executionObservations,
      ...resolvedFailures,
      ...callOutcomes,
      ...taskOutcomes,
    ],
    nodesById,
  );
  const plan = advanceWorkflowFromSchedulerState({
    checkpoint,
    schedulerState: applyWorkflowTestPolicy(
      schedulerState(input.executable),
      executableNodeList,
      input.test,
    ),
    observations: [
      ...executionObservations,
      ...branchSelections,
      ...resolvedFailures,
      ...calls.observations,
      ...callOutcomes,
      ...tasks.observations,
      ...taskOutcomes,
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
    hasExecutionSlot: input.hasExecutionSlot ?? true,
  });
  assertNotAborted(input.signal);
  return Object.freeze({
    ...plan,
    ...(calls.intents.length === 0 ? {} : { callIntents: calls.intents }),
    ...(tasks.intents.length === 0 ? {} : { taskIntents: tasks.intents }),
    attempts: plan.attempts.map((attempt) => {
      const key = nodeProviderIdempotencyKey(
        nodesById.get(attempt.nodeId),
        input.runId,
        attempt.invocationKey,
        attempt.sideEffectClass,
      );
      return Object.freeze({
        ...attempt,
        ...(key === undefined ? {} : { providerIdempotencyKey: key }),
      });
    }),
    nodeRunAdmissions: plan.nodeRunAdmissions.map((admission) => {
      const key = nodeProviderIdempotencyKey(
        nodesById.get(admission.nodeId),
        input.runId,
        admission.invocationKey,
        admission.sideEffectClass,
      );
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
  sourceFailure?: WorkflowNodeFailureValue,
  variables?: WorkspaceVariableValues,
): Promise<JsonValue> {
  if (isWorkflowTriggerDefinition(node.definition)) return runInput;
  const mapped = Object.create(null) as Record<string, JsonValue>;
  // Mappings resolve independently; their authored order is the input's.
  for (const key of Object.keys(node.inputMappings)) {
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
    if (
      source.kind === 'node_failure' &&
      sourceFailure?.nodeId !== source.nodeId
    )
      operationError(
        'attempt_invalid',
        'mapping selected source failure is incomplete',
      );
    let resolution: ValueResolution;
    try {
      resolution = await resolveValueSource(
        source,
        {
          runInput,
          nodeOutputs: completedOutputs,
          ...(variables === undefined ? {} : { variables }),
          ...(sourceFailure === undefined
            ? {}
            : { nodeFailure: sourceFailure }),
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
      operationError(
        resolution.code === 'variable_missing' ||
          resolution.expression?.code === 'variable_missing'
          ? 'variable_missing'
          : 'attempt_invalid',
        'Mapping could not resolve; check its inputs and captured workspace variables.',
      );
    if (resolution.kind === 'value') mapped[key] = resolution.value;
  }
  try {
    return normalizeBoundedEngineValue(mapped);
  } catch {
    operationError('attempt_invalid', 'mapped input exceeds runtime limits');
  }
}

/** Resolve one isolated preview node through the production ValueSource path. */
export async function resolveSingleNodePreviewInput(
  input: Readonly<{
    node: unknown;
    runInput: unknown;
    variables?: WorkspaceVariableValues;
    signal: AbortSignal;
    expressionEvaluator?: ExpressionEvaluator;
  }>,
): Promise<JsonValue> {
  let node: Pick<WorkflowExecutableNode, 'definition' | 'inputMappings'>;
  let runInput: JsonValue;
  try {
    runInput = normalizeBoundedEngineValue(input.runInput);
    const rawNode = record(
      normalizeBoundedEngineJson(input.node),
      'attempt_invalid',
      'preview node',
    );
    const parsedNode = parseWorkflowGraphDraft({
      edges: [],
      nodes: [{ ...rawNode, position: { x: 0, y: 0 } }],
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
    undefined,
    workspaceVariableValuesSchema.parse(input.variables ?? {}),
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
  const {
    node,
    runInput,
    variables,
    completedOutputs,
    directUpstream,
    structuredInputs,
    sourceFailure,
  } = prepareNodeAttemptInput(input);
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
    sourceFailure,
    variables,
  );
  let executionInput = resolvedInput;
  if (isCoreMergeDefinition(node.definition)) {
    if (input.coordinatorInput === undefined)
      operationError('attempt_invalid', 'settled Merge input is missing');
    try {
      executionInput = normalizeBoundedEngineValue(input.coordinatorInput);
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
