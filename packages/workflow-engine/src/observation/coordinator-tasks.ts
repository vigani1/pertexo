import {
  approvalConfigSchema,
  canonicalJson,
  continuesOnExpiry,
  inputRequestConfigSchema,
  TIMED_OUT_PORT,
  isPendingTaskNode,
  isCallbackWaitNode,
  callbackWaitConfigSchema,
  taskContextSchema,
  type TaskContext,
  type JsonValue,
} from '@pertexo/workflow-model';
import type {
  WorkflowExecutableGraph,
  ExecutionNode,
} from '../compilation/workflow-executable.js';
import { findExecutableNodeContext } from '../compilation/graph.js';
import {
  exactKeys,
  operationError,
  record,
} from '../input-checks/engine-values.js';
import {
  parseTaskOutcome,
  readTaskOutcomeWindow,
} from './pending-task-outcome.js';
import {
  configuredBranchOutputPorts,
  configuredScopedOutputPorts,
} from '../control-nodes/control-output-ports.js';
import { invocationKey } from '../invocations/invocation-identity.js';
import { isAgentWorkInvocationKey } from '../invocations/agent-invocation.js';
import {
  isFinishedIterationScope,
  isTerminalNodeStatus,
} from '../transition/transition-state.js';
import type {
  InvocationState,
  PendingTaskIntent,
  PendingTaskOutcome,
  WorkflowCheckpoint,
  WorkflowObservation,
} from '../workflow-execution.js';

/** A successful declaration opens a task; it cannot choose a decision path. */
export function taskDeclarationObservations(
  completedItems: readonly JsonValue[],
  successfulOutcomes: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>,
  invocations: ReadonlyMap<string, InvocationState>,
  nodes: ReadonlyMap<string, ExecutionNode>,
): Readonly<{
  intents: readonly PendingTaskIntent[];
  observations: readonly WorkflowObservation[];
  declarationInvocationKeys: ReadonlySet<string>;
}> {
  const declarations = new Set<string>();
  const intents: PendingTaskIntent[] = [];
  const pending = new Set<string>();
  const contexts = new Map<string, TaskContext>();
  for (const item of completedItems) {
    const material = item as Readonly<{
      sequence: number;
      attemptId: string;
      invocationKey: string;
      value: JsonValue;
    }>;
    const owner = invocations.get(material.invocationKey);
    if (!isPendingTaskNode(nodes.get(owner?.nodeId ?? ''))) continue;
    const value = record(
      material.value,
      'observation_invalid',
      'task declaration output',
    );
    exactKeys(value, ['pending'], ['context']);
    if (value.pending !== true)
      operationError('observation_invalid', 'task declaration is not pending');
    const identity = `${String(material.sequence)}\u0000${material.attemptId}\u0000${material.invocationKey}`;
    if (value.context !== undefined) {
      const context = taskContextSchema.safeParse(value.context);
      if (!context.success)
        operationError('observation_invalid', 'task context is invalid');
      contexts.set(identity, context.data);
    }
    pending.add(identity);
  }
  for (const [identity, outcome] of successfulOutcomes) {
    const owner =
      typeof outcome.invocationKey === 'string'
        ? invocations.get(outcome.invocationKey)
        : undefined;
    const node = nodes.get(owner?.nodeId ?? '');
    const notPendingTask =
      owner === undefined || node === undefined || !isPendingTaskNode(node);
    if (notPendingTask) continue;
    if (!pending.has(identity) || declarations.has(owner.invocationKey))
      operationError(
        'observation_invalid',
        'task declaration evidence is missing or conflicting',
      );
    declarations.add(owner.invocationKey);
    const context = contexts.get(identity);
    intents.push({
      invocationKey: owner.invocationKey,
      ...(context === undefined ? {} : { context }),
      ...pendingTaskSetup(node),
    });
  }
  return {
    intents,
    declarationInvocationKeys: declarations,
    observations: intents.map(({ invocationKey }) => ({
      kind: 'task_started',
      invocationKey,
      coordinatorDerived: true,
    })),
  };
}

/**
 * The task keeps its setup with every default filled in. Who may answer and
 * when it expires are read from it later, and a step left on the default
 * audience or expiry has neither in its graph config.
 */
function taskSetup<Setup>(
  schema: Readonly<{
    safeParse(
      value: unknown,
    ): Readonly<{ success: true; data: Setup }> | Readonly<{ success: false }>;
  }>,
  config: unknown,
): Setup {
  const parsed = schema.safeParse(config);
  if (!parsed.success)
    return operationError('observation_invalid', 'task setup is invalid');
  return parsed.data;
}

/** Typed stored task facts settle only their exact waiting invocation. */
export function taskOutcomeObservations(
  input: unknown,
  checkpoint: WorkflowCheckpoint,
  nodes: ReadonlyMap<string, ExecutionNode>,
  {
    graph,
    agentDecisions,
  }: Readonly<{
    graph: WorkflowExecutableGraph;
    agentDecisions: Map<string, PendingTaskOutcome['status']>;
  }>,
): readonly WorkflowObservation[] {
  const seen = new Map<string, string>();
  const invocations = new Map(
    checkpoint.invocations.map((owner) => [owner.invocationKey, owner]),
  );
  const observations: WorkflowObservation[] = [];
  for (const item of readTaskOutcomeWindow(input)) {
    const fact = parseTaskOutcome(item);
    const canonical = canonicalJson(fact);
    const previous = seen.get(fact.invocationKey);
    if (previous !== undefined) {
      if (previous !== canonical)
        operationError('observation_invalid', 'task outcomes conflict');
      continue;
    }
    seen.set(fact.invocationKey, canonical);
    const owner = invocations.get(fact.invocationKey);
    const agentApproval = isAgentWorkInvocationKey(fact.invocationKey);
    if (!agentApproval)
      assertTaskOutcomeScope(fact, { checkpoint, nodes, graph });
    if (owner === undefined) {
      if (isFinishedIterationScope(checkpoint.loops, fact)) continue;
      operationError(
        'observation_invalid',
        'task outcome invocation is unknown',
      );
    }
    if (isTerminalNodeStatus(owner.status)) {
      if (owner.output?.kind === 'task' && owner.output.taskId !== fact.taskId)
        operationError('observation_invalid', 'task result identity conflicts');
      continue;
    }
    if (owner.status !== 'waiting' || owner.waitKind !== 'human_task')
      operationError('observation_invalid', 'task outcome has no durable wait');
    if (agentApproval) {
      if (
        owner.agentWork?.work.kind !== 'model_turn' ||
        owner.nodeId !== fact.nodeId
      )
        operationError(
          'observation_invalid',
          'Agent approval does not belong to its model turn',
        );
      agentDecisions.set(fact.invocationKey, fact.status);
    }
    observations.push(...taskResultObservations(fact, owner, nodes));
  }
  return observations;
}

function pendingTaskSetup(node: ExecutionNode) {
  if (isCallbackWaitNode(node))
    return {
      kind: 'callback' as const,
      config: taskSetup(callbackWaitConfigSchema, node.config),
    };
  if (node.definition.key === 'core.approval')
    return {
      kind: 'approval' as const,
      config: taskSetup(approvalConfigSchema, node.config),
    };
  return {
    kind: 'input_request' as const,
    config: taskSetup(inputRequestConfigSchema, node.config),
  };
}

function assertTaskOutcomeScope(
  fact: PendingTaskOutcome,
  {
    checkpoint,
    nodes,
    graph,
  }: Readonly<{
    checkpoint: WorkflowCheckpoint;
    nodes: ReadonlyMap<string, ExecutionNode>;
    graph: WorkflowExecutableGraph;
  }>,
): void {
  const context = findExecutableNodeContext(graph, fact.nodeId);
  const expected = invocationKey({
    workflowVersionId: checkpoint.workflowVersionId,
    nodeId: fact.nodeId,
    branchPath: (fact.branchPath ?? []).map(
      ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
    ),
    iterationPath: fact.iterationPath ?? [],
  });
  const invalidTaskScope =
    !isPendingTaskNode(nodes.get(fact.nodeId)) ||
    expected !== fact.invocationKey ||
    context?.ancestors.length !== (fact.iterationPath?.length ?? 0) ||
    context.ancestors.some(
      (id, index) => fact.iterationPath?.[index]?.loopNodeId !== id,
    ) ||
    (fact.branchPath ?? []).some(
      ({ nodeId, outputPort }) =>
        !configuredScopedOutputPorts(nodes.get(nodeId) ?? {})?.includes(
          outputPort,
        ),
    );
  if (invalidTaskScope)
    operationError('observation_invalid', 'task outcome scope is invalid');
}

function taskResultObservations(
  fact: PendingTaskOutcome,
  owner: InvocationState,
  nodes: ReadonlyMap<string, ExecutionNode>,
): readonly WorkflowObservation[] {
  const agentApproval = owner.agentWork?.work.kind === 'model_turn';
  const node = agentApproval ? undefined : nodes.get(fact.nodeId);
  const inputRequest =
    node?.definition.key === 'core.request_input' || isCallbackWaitNode(node);
  const incompatibleTaskResult =
    (fact.status === 'submitted' && !inputRequest) ||
    (['approved', 'rejected'].includes(fact.status) && inputRequest);
  if (incompatibleTaskResult)
    operationError('observation_invalid', 'task result kind conflicts');
  // Silence settles like an answer when the step continues on Timed out.
  const timedOut =
    fact.status === 'expired' &&
    (agentApproval || (node !== undefined && continuesOnExpiry(node)));
  const settled =
    timedOut || ['approved', 'rejected', 'submitted'].includes(fact.status);
  const observations: WorkflowObservation[] = [
    settled
      ? settledTaskOutcome(fact, { node, timedOut })
      : unsettledTaskOutcome(fact, owner),
  ];
  const selectedOutputPort = settled
    ? selectedTaskPort(fact, { node, timedOut })
    : undefined;
  if (selectedOutputPort !== undefined)
    observations.push({
      kind: 'branch_selected',
      invocationKey: fact.invocationKey,
      nodeId: fact.nodeId,
      selectedOutputPort,
      coordinatorDerived: true,
    });
  return observations;
}

function settledTaskOutcome(
  fact: PendingTaskOutcome,
  {
    node,
    timedOut,
  }: Readonly<{ node: ExecutionNode | undefined; timedOut: boolean }>,
): WorkflowObservation {
  let reasonCode: string | undefined;
  if (timedOut) reasonCode = 'pending_task.timed_out';
  else if (isCallbackWaitNode(node)) reasonCode = 'callback.received';
  return {
    kind: 'outcome',
    invocationKey: fact.invocationKey,
    status: 'succeeded',
    output: { kind: 'task', taskId: fact.taskId },
    ...(reasonCode === undefined ? {} : { reasonCode }),
    coordinatorDerived: true,
  };
}

function unsettledTaskOutcome(
  fact: PendingTaskOutcome,
  owner: InvocationState,
): WorkflowObservation {
  if (fact.status === 'canceled')
    return {
      kind: 'outcome',
      invocationKey: fact.invocationKey,
      status: 'canceled',
      reasonCode: 'pending_task.expired',
      coordinatorDerived: true,
    };
  const reasonCode =
    fact.status === 'refused'
      ? 'pending_task.capacity_exceeded'
      : 'pending_task.expired';
  return {
    kind: 'outcome',
    invocationKey: fact.invocationKey,
    status: 'failed',
    reasonCode,
    failure: {
      nodeId: fact.nodeId,
      invocationKey: fact.invocationKey,
      attemptNumber: owner.attemptNumber,
      errorKind: 'human_task',
      safeErrorCode: reasonCode,
    },
    coordinatorDerived: true,
  };
}

/** The decision's own path, or Timed out; a step without branches has none. */
function selectedTaskPort(
  fact: PendingTaskOutcome,
  {
    node,
    timedOut,
  }: Readonly<{ node: ExecutionNode | undefined; timedOut: boolean }>,
): string | undefined {
  const ports =
    node === undefined ? undefined : configuredBranchOutputPorts(node);
  if (ports === undefined) return undefined;
  if (timedOut) return TIMED_OUT_PORT;
  return fact.status === 'submitted' ? 'out' : fact.status;
}
