import { WorkflowEngineError } from '../errors.js';
import type { SchedulerState } from './scheduling/readiness.js';
import { compareOrdinal } from '../ordering.js';
import { sameOutputReference } from '../output-reference.js';
import {
  branchPathHasPrefix,
  sameBranchPath,
  sameIterationPath,
} from '../scope.js';
import type {
  AttemptAdmissionPlan,
  BranchSelection,
  EngineEventName,
  EngineEventPlan,
  InvocationState,
  JoinState,
  LoopState,
  NodeStatus,
  RunStatus,
  WorkflowCheckpoint,
  WorkflowObservation,
} from '../types.js';

export interface MutableWorkflowTransition {
  readonly current: WorkflowCheckpoint;
  readonly graph: SchedulerState | undefined;
  readonly schedulerNodes: SchedulerNodeLookup | undefined;
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

export type SchedulerNodeLookup = ReadonlyMap<
  string,
  Readonly<{
    node: SchedulerState['nodes'][number];
    containingLoopId?: string;
  }>
>;

/** One transition-local projection, distinct from draft-validation indexes. */
export function indexTransitionNodes(
  graph: SchedulerState | undefined,
): SchedulerNodeLookup | undefined {
  if (graph === undefined) return undefined;
  const nodes = new Map<
    string,
    Readonly<{
      node: SchedulerState['nodes'][number];
      containingLoopId?: string;
    }>
  >(graph.nodes.map((node) => [node.id, Object.freeze({ node })]));
  for (const body of graph.structuredBodies ?? [])
    for (const node of body.nodes)
      nodes.set(
        node.id,
        Object.freeze({ node, containingLoopId: body.loopNodeId }),
      );
  return nodes;
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

export function isTerminalNodeStatus(
  status: NodeStatus | undefined,
): status is Extract<
  NodeStatus,
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'canceled'
  | 'timed_out'
  | 'outcome_unknown'
> {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'skipped' ||
    status === 'canceled' ||
    status === 'timed_out' ||
    status === 'outcome_unknown'
  );
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
      return `1:loop:${observation.controlInvocationKey}`;
    case 'loop_iteration_completed':
      return `2:loop:${observation.controlInvocationKey}:${String(observation.ordinal).padStart(16, '0')}`;
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
    joinInvocationKey: observation.joinInvocationKey,
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
    left.joinInvocationKey === right.joinInvocationKey &&
    left.joinId === right.joinId &&
    sameBranchPath(left.branchPath, right.branchPath) &&
    sameIterationPath(left.iterationPath, right.iterationPath) &&
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
    left.controlInvocationKey === right.controlInvocationKey &&
    left.loopId === right.loopId &&
    sameBranchPath(left.branchPath, right.branchPath) &&
    sameIterationPath(left.iterationPath, right.iterationPath) &&
    left.bodySinkNodeId === right.bodySinkNodeId &&
    left.bodyRootNodeIds.length === right.bodyRootNodeIds.length &&
    left.bodyRootNodeIds.every(
      (nodeId, index) => nodeId === right.bodyRootNodeIds[index],
    ) &&
    left.collection.kind === right.collection.kind &&
    sameOutputReference(left.collection, right.collection) &&
    left.collectionChecksum === right.collectionChecksum &&
    left.collectionSize === right.collectionSize &&
    left.maxIterations === right.maxIterations &&
    left.maxConcurrency === right.maxConcurrency
  );
}

export function schedulerNodeSideEffectClass(
  schedulerNodes: SchedulerNodeLookup | undefined,
  nodeId: string,
): AttemptAdmissionPlan['sideEffectClass'] {
  if (schedulerNodes === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'scheduler state is required for attempt admission',
    );
  const node = schedulerNodes.get(nodeId)?.node;
  if (node === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      `scheduler node ${nodeId} is missing`,
    );
  return node.sideEffectClass;
}

export function schedulerNodeDisabled(
  schedulerNodes: SchedulerNodeLookup | undefined,
  nodeId: string,
): boolean {
  return schedulerNodes?.get(nodeId)?.node.disabled === true;
}

export function scopedLoopSinkInvocation(
  loop: LoopState,
  ordinal: number,
  invocations: Iterable<InvocationState>,
): InvocationState | undefined {
  const iterationPath = [
    ...loop.iterationPath,
    { loopNodeId: loop.loopId, ordinal },
  ];
  const matches = [...invocations].filter(
    (candidate) =>
      candidate.nodeId === loop.bodySinkNodeId &&
      sameIterationPath(candidate.iterationPath, iterationPath) &&
      branchPathHasPrefix(candidate.branchPath, loop.branchPath),
  );
  if (matches.length > 1)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'loop sink has multiple scoped invocations',
    );
  return matches[0];
}

export function assertLoopInvocations(
  loop: LoopState,
  invocations: ReadonlyMap<string, InvocationState>,
): void {
  for (const ordinal of loop.activeOrdinals) {
    const iterationPath = [
      ...loop.iterationPath,
      { loopNodeId: loop.loopId, ordinal },
    ];
    const invocation = [...invocations.values()].find(
      (candidate) =>
        sameIterationPath(candidate.iterationPath, iterationPath) &&
        branchPathHasPrefix(candidate.branchPath, loop.branchPath),
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
        ? scopedLoopSinkInvocation(loop, ordinal, invocations.values())
        : [...invocations.values()].find(
            (candidate) =>
              sameIterationPath(candidate.iterationPath, iterationPath) &&
              branchPathHasPrefix(candidate.branchPath, loop.branchPath) &&
              candidate.status === loop.terminalStatus,
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
