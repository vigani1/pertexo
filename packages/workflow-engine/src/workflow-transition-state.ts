import { WorkflowEngineError } from './errors.js';
import type { SchedulerState } from './graph-scheduler.js';
import { compareOrdinal } from './ordering.js';
import { invocationKey as createInvocationKey } from './scheduling.js';
import type {
  AttemptAdmissionPlan,
  BranchSelection,
  EngineEventName,
  EngineEventPlan,
  InvocationState,
  JoinState,
  LoopState,
  NodeStatus,
  OutputReference,
  RunStatus,
  WorkflowCheckpoint,
} from './types.js';
import type { WorkflowObservation } from './advance-workflow.js';

export interface MutableWorkflowTransition {
  readonly current: WorkflowCheckpoint;
  readonly graph: SchedulerState | undefined;
  readonly invocations: Map<string, InvocationState>;
  readonly joins: Map<string, JoinState>;
  readonly loops: Map<string, LoopState>;
  readonly branchSelections: BranchSelection[];
  remainingIterationBudget: number;
  readonly eventDrafts: Omit<EngineEventPlan, 'sequence'>[];
  readonly nodeRunAdmissionKeys: Set<string>;
  readonly externalFactsArePersisted: boolean;
  cancelRequested: boolean;
  deadlineExpired: boolean;
  deadlineOccurredAt: string | undefined;
  runStatus: RunStatus;
}

export const nodeEventName: Readonly<
  Partial<Record<NodeStatus, EngineEventName>>
> = {
  ready: 'node.ready',
  waiting: 'node.waiting',
  succeeded: 'node.succeeded',
  failed: 'node.failed',
  skipped: 'node.skipped',
  canceled: 'node.canceled',
  timed_out: 'node.timed_out',
  outcome_unknown: 'node.outcome_unknown',
};

export function isTerminalNodeStatus(status: NodeStatus): boolean {
  return [
    'succeeded',
    'failed',
    'skipped',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ].includes(status);
}

export function sameOutputReference(
  left: OutputReference | undefined,
  right: OutputReference | undefined,
): boolean {
  if (left?.kind !== right?.kind) return false;
  if (left === undefined || right === undefined) return true;
  return left.kind === 'inline' && right.kind === 'inline'
    ? left.attemptId === right.attemptId
    : left.kind === 'artifact' && right.kind === 'artifact'
      ? left.artifactId === right.artifactId
      : false;
}

export function observationOrder(
  left: WorkflowObservation,
  right: WorkflowObservation,
): number {
  const leftKey = observationKey(left);
  const rightKey = observationKey(right);
  return (
    compareOrdinal(leftKey, rightKey) || compareOrdinal(left.kind, right.kind)
  );
}

function observationKey(observation: WorkflowObservation): string {
  switch (observation.kind) {
    case 'cursor_only':
    case 'cancel_requested':
    case 'deadline_expired':
      return '';
    case 'join_declared':
      return `1:join:${observation.joinId}`;
    case 'branch_disposition':
      return `2:join:${observation.joinId}:${observation.branch.branchId}`;
    case 'branch_selected':
      return `2:branch:${observation.invocationKey}:${observation.nodeId}`;
    case 'loop_started':
      return `1:loop:${observation.controlInvocationKey ?? observation.loopId}`;
    case 'loop_iteration_completed':
      return `2:loop:${observation.controlInvocationKey ?? observation.loopId}:${String(observation.ordinal).padStart(16, '0')}`;
    default:
      return `3:invocation:${observation.invocationKey}`;
  }
}

export function declaredJoin(
  observation: Extract<WorkflowObservation, { kind: 'join_declared' }>,
): JoinState {
  if (!observation.joinId)
    throw new WorkflowEngineError('join_invalid', 'join ID is required');
  const branchIds = [...observation.branchIds].sort();
  if (
    branchIds.length === 0 ||
    branchIds.some((branchId) => branchId.length === 0) ||
    new Set(branchIds).size !== branchIds.length
  )
    throw new WorkflowEngineError(
      'join_invalid',
      'a join requires unique non-empty branches',
    );
  if (
    observation.policy.kind === 'count' &&
    (!Number.isSafeInteger(observation.policy.count) ||
      observation.policy.count <= 0 ||
      observation.policy.count > branchIds.length)
  )
    throw new WorkflowEngineError(
      'join_invalid',
      'count join exceeds declared branches',
    );
  return {
    joinInvocationKey: observation.joinInvocationKey ?? observation.joinId,
    joinId: observation.joinId,
    branchPath: observation.branchPath ?? [],
    iterationPath: observation.iterationPath ?? [],
    policy: observation.policy,
    ledger: branchIds.map((branchId) => ({
      branchId,
      disposition: 'pending',
    })),
  };
}

export function sameJoinDeclaration(
  left: JoinState,
  right: JoinState,
): boolean {
  return (
    JSON.stringify(left.policy) === JSON.stringify(right.policy) &&
    left.ledger.length === right.ledger.length &&
    left.ledger.every(
      ({ branchId }, index) => branchId === right.ledger[index]?.branchId,
    )
  );
}

export function sameLoopDeclaration(
  left: LoopState,
  right: LoopState,
): boolean {
  return (
    left.loopId === right.loopId &&
    left.collection.kind === right.collection.kind &&
    sameOutputReference(left.collection, right.collection) &&
    left.collectionChecksum === right.collectionChecksum &&
    left.collectionSize === right.collectionSize &&
    left.maxIterations === right.maxIterations &&
    left.maxConcurrency === right.maxConcurrency
  );
}

export function rootInvocationKey(
  workflowVersionId: string,
  nodeId: string,
): string {
  return createInvocationKey({ workflowVersionId, nodeId });
}

export function schedulerNodeSideEffectClass(
  schedulerState: SchedulerState | undefined,
  nodeId: string,
): AttemptAdmissionPlan['sideEffectClass'] {
  if (schedulerState === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'scheduler state is required for attempt admission',
    );
  const node = [
    ...schedulerState.nodes,
    ...(schedulerState.structuredBodies?.flatMap(({ nodes }) => nodes) ?? []),
  ].find(({ id }) => id === nodeId);
  if (node === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      `scheduler node ${nodeId} is missing`,
    );
  return node.sideEffectClass;
}

export function schedulerNodeDisabled(
  schedulerState: SchedulerState | undefined,
  nodeId: string,
): boolean {
  if (schedulerState === undefined) return false;
  return (
    [
      ...schedulerState.nodes,
      ...(schedulerState.structuredBodies?.flatMap(({ nodes }) => nodes) ?? []),
    ].find(({ id }) => id === nodeId)?.disabled === true
  );
}

export function isSyntheticLegacyLoop(loop: LoopState): boolean {
  return (
    loop.bodyRootNodeIds.length === 1 &&
    loop.bodyRootNodeIds[0] === loop.loopId &&
    loop.bodySinkNodeId === loop.loopId
  );
}

export function assertLoopInvocations(
  workflowVersionId: string,
  loop: LoopState,
  invocations: ReadonlyMap<string, InvocationState>,
): void {
  for (const ordinal of loop.activeOrdinals) {
    const iterationPath = [
      ...loop.iterationPath,
      { loopNodeId: loop.loopId, ordinal },
    ];
    const invocation = isSyntheticLegacyLoop(loop)
      ? invocations.get(
          createInvocationKey({
            workflowVersionId,
            nodeId: loop.loopId,
            branchPath: loop.branchPath.map(
              ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
            ),
            iterationPath,
          }),
        )
      : [...invocations.values()].find(
          (candidate) =>
            JSON.stringify(candidate.iterationPath ?? []) ===
            JSON.stringify(iterationPath),
        );
    if (invocation === undefined)
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `active loop iteration ${loop.loopId}:${String(ordinal)} is inconsistent`,
      );
  }
  for (const ordinal of loop.terminalOrdinals) {
    const iterationPath = [
      ...loop.iterationPath,
      { loopNodeId: loop.loopId, ordinal },
    ];
    const invocation =
      loop.terminalStatus === undefined
        ? invocations.get(
            createInvocationKey({
              workflowVersionId,
              nodeId: loop.bodySinkNodeId,
              branchPath: loop.branchPath.map(
                ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
              ),
              iterationPath,
            }),
          )
        : [...invocations.values()].find(
            (candidate) =>
              JSON.stringify(candidate.iterationPath ?? []) ===
                JSON.stringify(iterationPath) &&
              isTerminalNodeStatus(candidate.status),
          );
    if (invocation === undefined || !isTerminalNodeStatus(invocation.status))
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `terminal loop iteration ${loop.loopId}:${String(ordinal)} is inconsistent`,
      );
  }
}

export function transitionEvent(
  name: EngineEventName,
  occurredAt: string,
  invocation?: InvocationState,
  reasonCode?: string,
  dueAt?: string,
): Omit<EngineEventPlan, 'sequence'> {
  return {
    schemaVersion: 1,
    name,
    occurredAt,
    ...(invocation === undefined
      ? {}
      : {
          invocationKey: invocation.invocationKey,
          nodeId: invocation.nodeId,
          attemptNumber: invocation.attemptNumber,
        }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(dueAt === undefined ? {} : { dueAt }),
  };
}
