import {
  NodeExecutionAbortedError,
  NodeExecutorFailure,
  type NodeExecutionResult,
} from '@pertexo/node-sdk/server';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model/graph';
import {
  resolveValueSource,
  type ValueResolution,
} from '@pertexo/workflow-model/mapping';

import { advanceWorkflowFromSchedulerState } from './transition/advance-workflow.js';
import { WorkflowEngineError } from './errors.js';
import { resolveAttemptFailures } from './observation/coordinator-failures.js';
import {
  branchSelectionObservations,
  mergeCoordinatorObservations,
} from './observation/coordinator-observations.js';
import { forEachCoordinatorObservations } from './observation/coordinator-loop-observations.js';
import {
  indexPersistedSuccessfulOutcomes,
  parseCompletedOutputItems,
  parseCompletedOutputItemsV3,
} from './observation/coordinator-output.js';
import { executableNodes } from './compilation/executable-graph.js';
import {
  normalizeBoundedEngineJson,
  type WorkflowExecutableNodeV2,
} from './executable-workflow.js';
import type { WorkflowObservation } from './types.js';
import { parseCheckpoint } from './checkpoint/checkpoint.js';
import type { SchedulerState } from './transition/graph-scheduler.js';
import { operationError, record } from './operation-values.js';
import { parsePersistedObservations } from './observation/persisted-observations.js';
import { withPlanProviderKeys } from './attempt/plan-provider-keys.js';
import { prepareNodeAttemptInput } from './attempt/node-attempt-input.js';
import type {
  ExecuteNodeAttemptInput,
  NodeAttemptOutcome,
} from './attempt/node-attempt-contract.js';
import type { WorkflowTransitionPlan } from './types.js';
import {
  isCoreMergeDefinition,
  isTriggerSourceDefinition,
} from './core-definition-identities.js';
import { assertCheckpointMatchesExecutable } from './checkpoint/checkpoint-executable-validation.js';
import {
  assertAuthenticWorkflowExecutable,
  type CompiledWorkflowExecutable,
} from './compilation/executable-authentication.js';
import { isAuthenticExecutableIdentityV3 } from './compilation/executable-v3.js';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import type { WorkflowCallDeclarationMaterialV1 } from './workflow-call-control.js';
import { workflowCallCoordinatorControls } from './observation/workflow-call-observations.js';
import { projectSchedulerState } from './compilation/executable-scheduler.js';
export { projectSchedulerState } from './compilation/executable-scheduler.js';
import {
  completeCallableTransition,
  type WorkflowCallableCompletionMaterial,
} from './observation/workflow-call-completion.js';
import type { LoadCallableCompletion } from './observation/workflow-call-demand.js';
import {
  recordedCallDeclarationAttemptInput,
  validateCallDeclarationAttemptInput,
  validateCallDeclarationAttemptResult,
} from './attempt/workflow-call-input.js';

export type {
  ExecuteNodeAttemptInput,
  NodeAttemptOutcome,
  NodeExecutionRegistry,
} from './attempt/node-attempt-contract.js';
export type {
  AttemptFailureObservation,
  DeadlineExpiredObservation,
  DueAtObservation,
  PersistedWorkflowObservation,
} from './observation/persisted-observations.js';

export interface AdvanceWorkflowInput {
  readonly runId: string;
  readonly executable: CompiledWorkflowExecutable;
  readonly workflowVersionId: string;
  readonly checkpoint: unknown;
  readonly observations?: unknown;
  readonly completedOutputs?: unknown;
  readonly callableCompletion?: WorkflowCallableCompletionMaterial;
  readonly loadCallableCompletion?: LoadCallableCompletion;
  readonly callableExpressionEvaluator?: ExpressionEvaluator;
  readonly workflowCalls?: Readonly<{
    readonly declarations: readonly WorkflowCallDeclarationMaterialV1[];
    readonly facts: readonly unknown[];
    readonly calleeDeclarations: ReadonlyMap<
      string,
      WorkflowCallableDeclarationV1
    >;
  }>;
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
  executable: CompiledWorkflowExecutable,
): SchedulerState {
  return projectSchedulerState(executable.envelope.graph);
}

export async function advanceWorkflow(
  input: AdvanceWorkflowInput,
): Promise<WorkflowTransitionPlan> {
  assertAuthenticWorkflowExecutable(input.executable);
  if (
    input.callableCompletion !== undefined &&
    input.loadCallableCompletion !== undefined
  )
    operationError(
      'observation_invalid',
      'eager and demand completion conflict',
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
  const callExecutable = isAuthenticExecutableIdentityV3(input.executable);
  if (callExecutable !== (checkpoint.schemaVersion === 3))
    operationError(
      'workflow_identity_invalid',
      'checkpoint format does not match the executable runtime',
    );
  if (!callExecutable && input.workflowCalls !== undefined)
    operationError(
      'observation_invalid',
      'Call materials require executable V3',
    );
  if (
    (input.callableCompletion !== undefined ||
      input.loadCallableCompletion !== undefined) &&
    (!callExecutable || input.executable.envelope.graph.callable === undefined)
  )
    operationError(
      'observation_invalid',
      'callable completion requires a callable V3 executable',
    );
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
  const completedOutputItems = callExecutable
    ? parseCompletedOutputItemsV3(input.completedOutputs)
    : parseCompletedOutputItems(input.completedOutputs);
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
    ...(callExecutable
      ? {
          nonRetryableNodeIds: new Set(
            executableNodeList
              .filter(
                ({ definition }) => definition.key === 'core.workflow_call',
              )
              .map(({ id }) => id),
          ),
        }
      : {}),
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
  const calls = isAuthenticExecutableIdentityV3(input.executable)
    ? workflowCallCoordinatorControls({
        executable: input.executable,
        checkpoint,
        observations: persistedObservations.observations,
        successfulOutcomes,
        materials: input.workflowCalls,
        controlCanceled,
        controlDeadline,
      })
    : { controls: [], declarationInvocationKeys: new Set<string>() };
  const executionObservations = persistedObservations.observations.map(
    (observation): WorkflowObservation =>
      observation.kind === 'outcome' &&
      (forEach.declarationInvocationKeys.has(observation.invocationKey) ||
        calls.declarationInvocationKeys.has(observation.invocationKey))
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
    workflowCallControls: calls.controls,
  });
  assertNotAborted(input.signal);
  const completedPlan = callExecutable
    ? await completeCallableTransition(
        input.executable,
        plan,
        input.callableCompletion,
        input.signal,
        input.loadCallableCompletion,
        input.callableExpressionEvaluator,
      )
    : plan;
  assertNotAborted(input.signal);
  return withPlanProviderKeys(completedPlan, nodesById, input.runId);
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
  node: Pick<WorkflowExecutableNodeV2, 'definition' | 'inputMappings'>,
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
  assertAuthenticWorkflowExecutable(input.executable);
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
  const recordedCallInput = recordedCallDeclarationAttemptInput(input, node);
  const resolvedInput =
    recordedCallInput === undefined
      ? await resolveMappedNodeInput(
          isCoreMergeDefinition(node.definition)
            ? { ...node, inputMappings: {} }
            : node,
          runInput,
          completedOutputs,
          directUpstream,
          input.signal,
          input.expressionEvaluator,
          structuredInputs,
        )
      : recordedCallInput.value;
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
  executionInput = validateCallDeclarationAttemptInput(
    input,
    node,
    executionInput,
  );
  // Native declarations must satisfy the pinned contract before their required
  // immutable snapshot is committed. Ordinary diagnostic recording is unchanged.
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
  if (node.definition.key === 'core.workflow_call')
    assertNotAborted(input.signal);
  result = validateCallDeclarationAttemptResult(node, executionInput, result);
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
