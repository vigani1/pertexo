import type { WorkflowTestPolicy } from '../testing/policy.js';
import {
  testStepDisposition,
  applyWorkflowTestPolicy,
} from '../testing/policy.js';
import {
  taskDeclarationObservations,
  taskOutcomeObservations,
} from '../observation/coordinator-tasks.js';
import { advanceWorkflowFromSchedulerState } from './advance.js';
import {
  advanceInlineChain,
  type InlineAdvanceOptions,
} from './advance-inline-chain.js';
import { resolveAttemptFailures } from '../observation/coordinator-failures.js';
import {
  branchSelectionObservations,
  mergeCoordinatorObservations,
} from '../observation/coordinator.js';
import {
  callDeclarationObservations,
  callOutcomeObservations,
} from '../observation/coordinator-calls.js';
import { forEachCoordinatorObservations } from '../observation/coordinator-loops.js';
import {
  indexPersistedSuccessfulOutcomes,
  parseCompletedOutputItems,
} from '../observation/coordinator-output.js';
import {
  assertAuthenticExecutableIdentity,
  executableControls,
  executableAgentTool,
  executableFailureRoutes,
  executableReadOnlyNodeIds,
  executionNodes,
} from '../compilation/verified-executable.js';
import type {
  CompiledWorkflowExecutable,
  ExecutionNode,
} from '../compilation/workflow-executable.js';
import type {
  PendingTaskOutcome,
  WorkflowObservation,
} from '../workflow-execution.js';
import {
  isAgentWorkInvocationKey,
  isAgentModelTurnInvocationKey,
} from '../invocations/agent-invocation.js';
import { parseCheckpoint } from '../checkpoint/create-and-parse.js';
import type { SchedulerState } from './scheduling/policy.js';
import { projectSchedulerState } from './scheduling/project-scheduler.js';
import { operationError, record } from '../input-checks/engine-values.js';
import { parsePersistedObservations } from '../observation/persisted.js';
import { nodeProviderIdempotencyKey } from '../attempt/derive-provider-key.js';
import type { WorkflowTransitionPlan } from '../workflow-execution.js';
import { assertCheckpointMatchesExecutable } from '../checkpoint/matches-executable.js';
import { assertIdentity, assertNotAborted } from '../attempt/admission.js';
import type { AgentModelRates } from '../control-nodes/agent-continuation.js';
import {
  agentSchedulerFor,
  graphStepOutputs,
} from './scheduling/agent-scheduler.js';
export interface AdvanceWorkflowInput {
  readonly agentModelRates?: (model: string) => AgentModelRates | undefined;
  readonly test?: WorkflowTestPolicy;
  readonly inline?: InlineAdvanceOptions;
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
function schedulerState(
  executable: CompiledWorkflowExecutable,
): SchedulerState {
  const routes = executableFailureRoutes(executable);
  return {
    ...projectSchedulerState(
      executable.envelope.graph,
      executableControls(executable),
      executableReadOnlyNodeIds(executable),
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
    agentDecisions,
    forEach,
    executionObservations,
    coordinatorObservations,
  } = coordinateObservations({
    input,
    checkpoint,
    nodesById,
    invocationsByKey,
  });
  const agentScheduler = agentSchedulerFor({ ...input, agentDecisions });
  const schedulerInput = {
    checkpoint,
    agentScheduler,
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
  };
  const plan =
    input.inline === undefined || agentScheduler !== undefined
      ? advanceWorkflowFromSchedulerState(schedulerInput)
      : await advanceInlineChain(
          input,
          schedulerInput,
          nodesById,
          input.inline,
        );
  assertNotAborted(input.signal);
  return Object.freeze({
    ...plan,
    ...(calls.intents.length === 0 ? {} : { callIntents: calls.intents }),
    ...(tasks.intents.length === 0
      ? {}
      : { taskIntents: [...tasks.intents, ...(plan.taskIntents ?? [])] }),
    attempts: plan.attempts.map((attempt) => {
      const key = nodeProviderIdempotencyKey(
        providerKeyNode(input.executable, nodesById, attempt),
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
        providerKeyNode(input.executable, nodesById, admission),
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

function providerKeyNode(
  executable: CompiledWorkflowExecutable,
  nodes: ReadonlyMap<string, ExecutionNode>,
  {
    nodeId,
    invocationKey,
  }: Readonly<{ nodeId: string; invocationKey: string }>,
) {
  return isAgentWorkInvocationKey(invocationKey) &&
    !isAgentModelTurnInvocationKey(invocationKey)
    ? executableAgentTool(executable, nodeId)?.node
    : nodes.get(nodeId);
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
  const completedOutputItems = graphStepOutputs(
    parseCompletedOutputItems(input.completedOutputs),
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
    agentToolFor: (nodeId) =>
      executableAgentTool(input.executable, nodeId)?.node,
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
    (nodeId) => executableAgentTool(input.executable, nodeId),
  );
  const callOutcomes = callOutcomeObservations(
    input.callOutcomes,
    checkpoint,
    nodesById,
    {
      graph: input.executable.envelope.graph,
      agentToolFor: (nodeId) => executableAgentTool(input.executable, nodeId),
    },
  );
  const tasks = taskDeclarationObservations(
    completedOutputItems,
    successfulOutcomes,
    invocationsByKey,
    declarationNodes,
  );
  const agentDecisions = new Map<string, PendingTaskOutcome['status']>();
  const taskOutcomes = taskOutcomeObservations(
    input.taskOutcomes,
    checkpoint,
    nodesById,
    { graph: input.executable.envelope.graph, agentDecisions },
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
    agentDecisions,
    forEach,
    executionObservations,
    coordinatorObservations,
  };
}
