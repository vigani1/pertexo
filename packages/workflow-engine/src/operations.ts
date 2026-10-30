import type { WorkflowTestPolicy } from './testing/policy.js';
import {
  testStepDisposition,
  applyWorkflowTestPolicy,
} from './testing/policy.js';

import {
  taskDeclarationObservations,
  taskOutcomeObservations,
} from './observation/coordinator-tasks.js';

import { advanceWorkflowFromSchedulerState } from './transition/advance.js';

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
import {
  assertAuthenticExecutableIdentity,
  executableControls,
  executableFailureRoutes,
  executionNodes,
  type CompiledWorkflowExecutable,
  type ExecutionNode,
  type WorkflowExecutableGraph,
} from './compilation/foundation.js';
import type { ControlNodeConfig } from '@pertexo/workflow-model';

import type { WorkflowObservation } from './types.js';
import { parseCheckpoint } from './checkpoint/create-and-parse.js';
import type { SchedulerState } from './transition/scheduling/readiness.js';
import { operationError, record } from './operation-values.js';
import { parsePersistedObservations } from './observation/persisted.js';
import { nodeProviderIdempotencyKey } from './attempt/derive-provider-key.js';
import type { WorkflowTransitionPlan } from './types.js';

import { assertCheckpointMatchesExecutable } from './checkpoint/matches-executable.js';
import { assertIdentity, assertNotAborted } from './attempt/admission.js';
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
export { resolveSingleNodePreviewInput } from './attempt/mapping.js';
export { executeNodeAttempt } from './attempt/execute.js';
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

export function projectSchedulerState(
  graph: WorkflowExecutableGraph,
  controls: ReadonlyMap<string, ControlNodeConfig>,
): SchedulerState {
  const projectGraph = (graph: WorkflowExecutableGraph): SchedulerState => {
    const nodes = graph.nodes.map(
      ({
        id,
        definition,
        config,
        disabled,
        sideEffectClass: pinnedSideEffectClass,
      }) => {
        const control = controls.get(id);
        return {
          id,
          definition,
          config,
          ...(control === undefined ? {} : { control }),
          disabled,
          sideEffectClass: pinnedSideEffectClass,
        };
      },
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
    ...projectSchedulerState(
      executable.envelope.graph,
      executableControls(executable),
    ),
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
  const executableNodeList = executionNodes(input.executable);
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
  const {
    persistedObservations,
    branchSelections,
    resolvedFailures,
    calls,
    callOutcomes,
    tasks,
    taskOutcomes,
    forEach,
    executionObservations,
    coordinatorObservations,
  } = coordinateObservations({
    input,
    checkpoint,
    nodesById,
    invocationsByKey,
  });
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

function coordinateObservations({
  input,
  checkpoint,
  nodesById,
  invocationsByKey,
}: Readonly<{
  input: AdvanceWorkflowInput;
  checkpoint: ReturnType<typeof parseCheckpoint>;
  nodesById: ReadonlyMap<string, ExecutionNode>;
  invocationsByKey: ReadonlyMap<
    string,
    ReturnType<typeof parseCheckpoint>['invocations'][number]
  >;
}>) {
  const test = input.test;
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
  const branchSelections = branchSelectionObservations({
    completedItems: completedOutputItems,
    successfulOutcomes: successfulOutcomes,
    invocations: invocationsByKey,
    nodes: nodesById,
    test: input.test !== undefined,
  });
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
  // Only executed steps can declare work; pinned outputs remain final samples.
  const declarationNodes =
    test === undefined
      ? nodesById
      : new Map(
          [...nodesById].filter(
            ([, node]) => testStepDisposition(node, test).kind === 'execute',
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
  const forEach = forEachCoordinatorObservations({
    completedItems: completedOutputItems,
    persistedItems: persistedObservations.facts.filter((fact) => {
      const value = record(fact, 'observation_invalid', 'persisted fact');
      return (
        value.kind !== 'outcome' ||
        (!calls.declarationInvocationKeys.has(value.invocationKey as string) &&
          !tasks.declarationInvocationKeys.has(value.invocationKey as string))
      );
    }),
    successfulOutcomes: successfulOutcomes,
    checkpoint: checkpoint,
    invocations: invocationsByKey,
    nodes:
      test === undefined
        ? nodesById
        : new Map(
            [...nodesById].filter(
              ([, node]) =>
                node.structured === undefined ||
                testStepDisposition(node, test).kind !== 'pinned',
            ),
          ),
    derivedObservations: [
      ...resolvedFailures,
      ...callOutcomes,
      ...taskOutcomes,
    ],
  });
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
  return {
    persistedObservations,
    branchSelections,
    resolvedFailures,
    calls,
    callOutcomes,
    tasks,
    taskOutcomes,
    forEach,
    executionObservations,
    coordinatorObservations,
  };
}
