import { parseCheckpoint, reconstructReadySet } from './checkpoint.js';
import { WorkflowEngineError } from './errors.js';
import { deriveReadyNodes, type SchedulerGraph } from './graph-scheduler.js';
import {
  admitLoopIterations,
  completeLoopIteration,
  createLoopState,
  invocationKey as createInvocationKey,
  recordBranchDisposition,
  settleJoin,
} from './scheduling.js';
import { assertNodeTransition, assertRunTransition } from './transitions.js';
import type {
  AttemptAdmissionPlan,
  BranchLedgerEntry,
  EngineEventName,
  EngineEventPlan,
  InvocationState,
  JoinPolicy,
  JoinState,
  LoopState,
  NodeStatus,
  OutputReference,
  WorkflowCheckpointV1,
  WorkflowTransitionPlan,
} from './types.js';

export type WorkflowObservation =
  | {
      readonly kind: 'ready';
      readonly invocationKey: string;
      readonly nodeId: string;
    }
  | {
      readonly kind: 'outcome';
      readonly invocationKey: string;
      readonly status: Extract<
        NodeStatus,
        | 'succeeded'
        | 'failed'
        | 'canceled'
        | 'timed_out'
        | 'outcome_unknown'
        | 'skipped'
      >;
      readonly output?: OutputReference;
      readonly reasonCode?: string;
    }
  | {
      readonly kind: 'wait';
      readonly invocationKey: string;
      readonly resumeAt: string;
    }
  | { readonly kind: 'resume'; readonly invocationKey: string }
  | { readonly kind: 'cancel_requested' }
  | {
      readonly kind: 'join_declared';
      readonly joinId: string;
      readonly policy: JoinPolicy;
      readonly branchIds: readonly string[];
    }
  | {
      readonly kind: 'branch_disposition';
      readonly joinId: string;
      readonly branch: BranchLedgerEntry;
    }
  | {
      readonly kind: 'loop_started';
      readonly loopId: string;
      readonly collection: OutputReference;
      readonly collectionChecksum: string;
      readonly collectionSize: number;
      readonly maxIterations: number;
      readonly maxConcurrency: number;
    }
  | {
      readonly kind: 'loop_iteration_completed';
      readonly loopId: string;
      readonly ordinal: number;
      readonly status?: Extract<
        NodeStatus,
        'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown'
      >;
      readonly output?: OutputReference;
      readonly reasonCode?: string;
    };

export interface AdvanceWorkflowInput {
  readonly checkpoint: WorkflowCheckpointV1;
  readonly graph?: SchedulerGraph;
  readonly observations?: readonly WorkflowObservation[];
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
}

const nodeEventName: Readonly<Partial<Record<NodeStatus, EngineEventName>>> = {
  ready: 'node.ready',
  waiting: 'node.waiting',
  succeeded: 'node.succeeded',
  failed: 'node.failed',
  skipped: 'node.skipped',
  canceled: 'node.canceled',
  timed_out: 'node.timed_out',
  outcome_unknown: 'node.outcome_unknown',
};

export function advanceWorkflow(
  input: AdvanceWorkflowInput,
): WorkflowTransitionPlan {
  if (
    !Number.isSafeInteger(input.maximumAdmissions) ||
    input.maximumAdmissions < 0
  ) {
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'maximumAdmissions must be non-negative',
    );
  }
  const current = parseCheckpoint(input.checkpoint);
  const invocations = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const joins = new Map(
    current.joins.map((join) => [join.joinId, join] as const),
  );
  const loops = new Map(
    current.loops.map((loop) => [loop.loopId, loop] as const),
  );
  let remainingIterationBudget = current.remainingIterationBudget;
  const eventDrafts: Omit<EngineEventPlan, 'sequence'>[] = [];
  let cancelRequested = current.cancelRequested;
  let runStatus = current.runStatus;
  const coordinatorNodeIds = new Set([
    ...current.joins.map(({ joinId }) => joinId),
    ...current.loops.map(({ loopId }) => loopId),
    ...(input.observations ?? []).flatMap((observation) =>
      observation.kind === 'join_declared'
        ? [observation.joinId]
        : observation.kind === 'loop_started'
          ? [observation.loopId]
          : [],
    ),
  ]);

  if (runStatus === 'queued') {
    assertRunTransition(runStatus, 'running');
    runStatus = 'running';
    eventDrafts.push(event('run.started', input.occurredAt));
  }

  if (
    input.graph !== undefined &&
    !cancelRequested &&
    (runStatus === 'running' || runStatus === 'waiting')
  ) {
    for (const decision of deriveReadyNodes({
      graph: input.graph,
      workflowVersionId: current.workflowVersionId,
      invocations: [...invocations.values()],
    })) {
      if (coordinatorNodeIds.has(decision.nodeId)) continue;
      const invocation: InvocationState = {
        invocationKey: decision.invocationKey,
        nodeId: decision.nodeId,
        status: decision.disposition,
        attemptNumber: 0,
      };
      invocations.set(invocation.invocationKey, invocation);
      eventDrafts.push(
        event(
          decision.disposition === 'ready' ? 'node.ready' : 'node.skipped',
          input.occurredAt,
          invocation,
        ),
      );
    }
  }

  const observations = [...(input.observations ?? [])].sort(observationOrder);
  for (const observation of observations) {
    if (observation.kind === 'cancel_requested') {
      if (!cancelRequested)
        eventDrafts.push(event('run.cancel_requested', input.occurredAt));
      cancelRequested = true;
      continue;
    }
    if (observation.kind === 'join_declared') {
      if (cancelRequested) continue;
      const declared = declaredJoin(observation);
      const existingJoin = joins.get(observation.joinId);
      if (existingJoin !== undefined) {
        if (!sameJoinDeclaration(existingJoin, declared))
          throw new WorkflowEngineError(
            'join_invalid',
            `join ${observation.joinId} conflicts with its declaration`,
          );
        continue;
      }
      joins.set(declared.joinId, declared);
      const joinKey = rootInvocationKey(
        current.workflowVersionId,
        observation.joinId,
      );
      if (!invocations.has(joinKey))
        invocations.set(joinKey, {
          invocationKey: joinKey,
          nodeId: observation.joinId,
          status: 'pending',
          attemptNumber: 0,
        });
      continue;
    }
    if (observation.kind === 'branch_disposition') {
      const join = joins.get(observation.joinId);
      if (join === undefined)
        throw new WorkflowEngineError(
          'join_invalid',
          `join ${observation.joinId} is not declared`,
        );
      joins.set(observation.joinId, {
        ...join,
        ledger: recordBranchDisposition(join.ledger, observation.branch),
      });
      continue;
    }
    if (observation.kind === 'loop_started') {
      if (cancelRequested) continue;
      const declared = createLoopState({
        ...observation,
        remainingIterationBudget,
      });
      const existingLoop = loops.get(observation.loopId);
      if (existingLoop !== undefined) {
        if (!sameLoopDeclaration(existingLoop, declared))
          throw new WorkflowEngineError(
            'loop_state_invalid',
            `loop ${observation.loopId} conflicts with its declaration`,
          );
        continue;
      }
      loops.set(declared.loopId, declared);
      const loopKey = rootInvocationKey(
        current.workflowVersionId,
        observation.loopId,
      );
      if (!invocations.has(loopKey))
        invocations.set(loopKey, {
          invocationKey: loopKey,
          nodeId: observation.loopId,
          status: 'pending',
          attemptNumber: 0,
        });
      continue;
    }
    if (observation.kind === 'loop_iteration_completed') {
      const loop = loops.get(observation.loopId);
      if (loop === undefined)
        throw new WorkflowEngineError(
          'loop_state_invalid',
          `loop ${observation.loopId} is not declared`,
        );
      const iterationKey = loopInvocationKey(
        current.workflowVersionId,
        loop.loopId,
        observation.ordinal,
      );
      const iteration = invocations.get(iterationKey);
      if (iteration === undefined)
        throw new WorkflowEngineError(
          'loop_state_invalid',
          `loop iteration ${iterationKey} has no invocation`,
        );
      const status = observation.status ?? 'succeeded';
      if (loop.terminalOrdinals.includes(observation.ordinal)) {
        if (
          iteration.status === status &&
          sameOutputReference(iteration.output, observation.output)
        )
          continue;
        assertNodeTransition(iteration.status, status);
        continue;
      }
      assertNodeTransition(iteration.status, status);
      const completedInvocation: InvocationState = {
        ...iteration,
        status,
        ...(observation.output === undefined
          ? {}
          : { output: observation.output }),
      };
      invocations.set(iterationKey, completedInvocation);
      loops.set(loop.loopId, completeLoopIteration(loop, observation.ordinal));
      const eventName = nodeEventName[status];
      if (eventName === undefined)
        throw new WorkflowEngineError(
          'checkpoint_invalid',
          `missing event mapping for ${status}`,
        );
      eventDrafts.push(
        event(
          eventName,
          input.occurredAt,
          completedInvocation,
          observation.reasonCode,
        ),
      );
      continue;
    }
    const existing = invocations.get(observation.invocationKey);
    if (observation.kind === 'ready') {
      if (cancelRequested || existing !== undefined) continue;
      const ready: InvocationState = {
        invocationKey: observation.invocationKey,
        nodeId: observation.nodeId,
        status: 'ready',
        attemptNumber: 0,
      };
      invocations.set(observation.invocationKey, ready);
      eventDrafts.push(event('node.ready', input.occurredAt, ready));
      continue;
    }
    if (existing === undefined) {
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `unknown invocation ${observation.invocationKey}`,
      );
    }
    if (observation.kind === 'wait') {
      assertNodeTransition(existing.status, 'waiting');
      invocations.set(existing.invocationKey, {
        ...existing,
        status: 'waiting',
        resumeAt: observation.resumeAt,
      });
      eventDrafts.push(event('node.waiting', input.occurredAt, existing));
      continue;
    }
    if (observation.kind === 'resume') {
      assertNodeTransition(existing.status, 'ready');
      const { resumeAt: _, ...rest } = existing;
      void _;
      const resumed = { ...rest, status: 'ready' as const };
      invocations.set(existing.invocationKey, resumed);
      eventDrafts.push(event('node.ready', input.occurredAt, resumed));
      if (runStatus === 'waiting') {
        assertRunTransition(runStatus, 'running');
        runStatus = 'running';
      }
      continue;
    }
    if (isTerminalNodeStatus(existing.status)) {
      if (
        existing.status === observation.status &&
        sameOutputReference(existing.output, observation.output)
      )
        continue;
      assertNodeTransition(existing.status, observation.status);
      continue;
    }
    assertNodeTransition(existing.status, observation.status);
    const completed: InvocationState = {
      ...existing,
      status: observation.status,
      ...(observation.output === undefined
        ? {}
        : { output: observation.output }),
    };
    invocations.set(existing.invocationKey, completed);
    const eventName = nodeEventName[observation.status];
    if (eventName === undefined) {
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `missing event mapping for ${observation.status}`,
      );
    }
    eventDrafts.push(
      event(eventName, input.occurredAt, completed, observation.reasonCode),
    );
  }

  for (const join of [...joins.values()].sort((left, right) =>
    left.joinId.localeCompare(right.joinId),
  )) {
    if (
      join.selectedBranchIds !== undefined ||
      join.unsatisfiedReasonCode !== undefined
    )
      continue;
    const decision = settleJoin(join);
    if (decision.kind === 'waiting') continue;
    const joinKey = rootInvocationKey(current.workflowVersionId, join.joinId);
    const invocation = invocations.get(joinKey);
    if (invocation === undefined)
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `join ${join.joinId} has no invocation`,
      );
    if (decision.kind === 'satisfied') {
      joins.set(join.joinId, {
        ...join,
        ledger: decision.ledger,
        selectedBranchIds: decision.selectedBranchIds,
      });
      if (invocation.status === 'pending') {
        assertNodeTransition(invocation.status, 'ready');
        const ready = { ...invocation, status: 'ready' as const };
        invocations.set(joinKey, ready);
        eventDrafts.push(event('node.ready', input.occurredAt, ready));
      }
      continue;
    }
    joins.set(join.joinId, {
      ...join,
      ledger: decision.ledger,
      unsatisfiedReasonCode: decision.reasonCode,
    });
    if (invocation.status === 'pending') {
      assertNodeTransition(invocation.status, 'ready');
      const ready = { ...invocation, status: 'ready' as const };
      eventDrafts.push(event('node.ready', input.occurredAt, ready));
      assertNodeTransition(ready.status, 'running');
      const running = { ...ready, status: 'running' as const };
      assertNodeTransition(running.status, 'failed');
      const failed = { ...running, status: 'failed' as const };
      invocations.set(joinKey, failed);
      eventDrafts.push(
        event('node.failed', input.occurredAt, failed, decision.reasonCode),
      );
    }
  }

  if (!cancelRequested) {
    for (const loop of [...loops.values()].sort((left, right) =>
      left.loopId.localeCompare(right.loopId),
    )) {
      assertLoopInvocations(current.workflowVersionId, loop, invocations);
      const admission = admitLoopIterations(loop, remainingIterationBudget);
      remainingIterationBudget = admission.remainingIterationBudget;
      loops.set(loop.loopId, admission.loop);
      for (const ordinal of admission.admittedOrdinals) {
        const iterationKey = loopInvocationKey(
          current.workflowVersionId,
          loop.loopId,
          ordinal,
        );
        if (invocations.has(iterationKey))
          throw new WorkflowEngineError(
            'loop_state_invalid',
            `loop iteration ${iterationKey} was admitted twice`,
          );
        const ready: InvocationState = {
          invocationKey: iterationKey,
          nodeId: loop.loopId,
          status: 'ready',
          attemptNumber: 0,
        };
        invocations.set(iterationKey, ready);
        eventDrafts.push(event('node.ready', input.occurredAt, ready));
      }
      const updated = admission.loop;
      if (
        updated.nextOrdinal === updated.collectionSize &&
        updated.activeOrdinals.length === 0
      ) {
        const loopKey = rootInvocationKey(
          current.workflowVersionId,
          updated.loopId,
        );
        const parent = invocations.get(loopKey);
        if (parent === undefined)
          throw new WorkflowEngineError(
            'checkpoint_invalid',
            `loop ${updated.loopId} has no parent invocation`,
          );
        if (parent.status === 'pending') {
          assertNodeTransition(parent.status, 'ready');
          const ready = { ...parent, status: 'ready' as const };
          eventDrafts.push(event('node.ready', input.occurredAt, ready));
          assertNodeTransition(ready.status, 'running');
          const running = { ...ready, status: 'running' as const };
          assertNodeTransition(running.status, 'succeeded');
          const succeeded = { ...running, status: 'succeeded' as const };
          invocations.set(loopKey, succeeded);
          eventDrafts.push(
            event('node.succeeded', input.occurredAt, succeeded),
          );
        }
      }
    }
  }

  if (cancelRequested) {
    for (const loop of loops.values()) {
      let updated = loop;
      for (const ordinal of loop.activeOrdinals) {
        const iterationKey = loopInvocationKey(
          current.workflowVersionId,
          loop.loopId,
          ordinal,
        );
        const iteration = invocations.get(iterationKey);
        if (iteration?.status !== 'ready') continue;
        assertNodeTransition(iteration.status, 'canceled');
        const canceled = { ...iteration, status: 'canceled' as const };
        invocations.set(iterationKey, canceled);
        eventDrafts.push(event('node.canceled', input.occurredAt, canceled));
        updated = completeLoopIteration(updated, ordinal);
      }
      loops.set(loop.loopId, updated);
    }
    const activeLoopParents = new Set(
      [...loops.values()]
        .filter(({ activeOrdinals }) => activeOrdinals.length > 0)
        .map(({ loopId }) =>
          rootInvocationKey(current.workflowVersionId, loopId),
        ),
    );
    for (const invocation of invocations.values()) {
      if (invocation.status !== 'pending' && invocation.status !== 'ready')
        continue;
      if (activeLoopParents.has(invocation.invocationKey)) continue;
      assertNodeTransition(invocation.status, 'canceled');
      const canceled = { ...invocation, status: 'canceled' as const };
      invocations.set(invocation.invocationKey, canceled);
      eventDrafts.push(event('node.canceled', input.occurredAt, canceled));
    }
  }

  const ordered = [...invocations.values()].sort((left, right) =>
    left.invocationKey.localeCompare(right.invocationKey),
  );
  const readySet = ordered
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey);
  const admittedKeys = cancelRequested
    ? []
    : readySet.slice(0, input.maximumAdmissions);
  const attempts: AttemptAdmissionPlan[] = [];
  for (const key of admittedKeys) {
    const invocation = invocations.get(key);
    if (invocation === undefined) {
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `ready invocation ${key} is missing`,
      );
    }
    assertNodeTransition(invocation.status, 'running');
    const running = {
      ...invocation,
      status: 'running' as const,
      attemptNumber: invocation.attemptNumber + 1,
    };
    invocations.set(key, running);
    attempts.push({
      invocationKey: key,
      nodeId: running.nodeId,
      attemptNumber: running.attemptNumber,
    });
  }

  const finalInvocations = [...invocations.values()].sort((left, right) =>
    left.invocationKey.localeCompare(right.invocationKey),
  );
  const nonterminal = finalInvocations.filter(({ status }) =>
    ['pending', 'ready', 'running', 'waiting'].includes(status),
  );
  const graphIncomplete =
    input.graph?.nodes.some(
      ({ id }) => !finalInvocations.some(({ nodeId }) => nodeId === id),
    ) === true;
  const runIsActive = runStatus === 'running' || runStatus === 'waiting';
  if (runIsActive && nonterminal.length === 0) {
    const terminalStatus = deriveTerminalRunStatus({
      cancelRequested,
      graphIncomplete,
      invocations: finalInvocations,
    });
    if (terminalStatus !== undefined) {
      assertRunTransition(runStatus, terminalStatus);
      runStatus = terminalStatus;
      eventDrafts.push(event(`run.${terminalStatus}`, input.occurredAt));
    }
  } else if (
    runStatus === 'running' &&
    nonterminal.length > 0 &&
    nonterminal.every(({ status }) => status === 'waiting')
  ) {
    assertRunTransition(runStatus, 'waiting');
    runStatus = 'waiting';
    eventDrafts.push(event('run.waiting', input.occurredAt));
  }

  const events = eventDrafts.map((draft, offset) => ({
    ...draft,
    sequence: current.nextEventSequence + offset,
  }));
  const checkpoint = parseCheckpoint({
    ...current,
    revision: current.revision + 1,
    runStatus,
    nextEventSequence: current.nextEventSequence + events.length,
    cancelRequested,
    joins: [...joins.values()],
    loops: [...loops.values()],
    remainingIterationBudget,
    admittedInvocationKeys: [
      ...new Set([...current.admittedInvocationKeys, ...admittedKeys]),
    ].sort(),
    invocations: finalInvocations,
    readySet: reconstructReadySet({
      ...current,
      invocations: finalInvocations,
    }),
  });
  return { expectedRevision: current.revision, checkpoint, events, attempts };
}

function isTerminalNodeStatus(status: NodeStatus): boolean {
  return [
    'succeeded',
    'failed',
    'skipped',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ].includes(status);
}

function sameOutputReference(
  left: OutputReference | undefined,
  right: OutputReference | undefined,
): boolean {
  return left?.kind === right?.kind && left?.reference === right?.reference;
}

function deriveTerminalRunStatus(input: {
  readonly cancelRequested: boolean;
  readonly graphIncomplete: boolean;
  readonly invocations: readonly InvocationState[];
}):
  | Extract<
      WorkflowCheckpointV1['runStatus'],
      'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown'
    >
  | undefined {
  const statuses = new Set(input.invocations.map(({ status }) => status));
  if (statuses.has('outcome_unknown')) return 'outcome_unknown';
  if (input.cancelRequested) return 'canceled';
  if (statuses.has('timed_out')) return 'timed_out';
  if (statuses.has('failed')) return 'failed';
  if (statuses.has('canceled')) return 'canceled';
  if (
    input.invocations.length > 0 &&
    !input.graphIncomplete &&
    [...statuses].every(
      (status) => status === 'succeeded' || status === 'skipped',
    )
  )
    return 'succeeded';
  return undefined;
}

function observationOrder(
  left: WorkflowObservation,
  right: WorkflowObservation,
): number {
  const leftKey = observationKey(left);
  const rightKey = observationKey(right);
  return leftKey.localeCompare(rightKey) || left.kind.localeCompare(right.kind);
}

function observationKey(observation: WorkflowObservation): string {
  switch (observation.kind) {
    case 'cancel_requested':
      return '';
    case 'join_declared':
      return `1:join:${observation.joinId}`;
    case 'branch_disposition':
      return `2:join:${observation.joinId}:${observation.branch.branchId}`;
    case 'loop_started':
      return `1:loop:${observation.loopId}`;
    case 'loop_iteration_completed':
      return `2:loop:${observation.loopId}:${String(observation.ordinal).padStart(16, '0')}`;
    default:
      return `3:invocation:${observation.invocationKey}`;
  }
}

function declaredJoin(
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
    joinId: observation.joinId,
    policy: observation.policy,
    ledger: branchIds.map((branchId) => ({
      branchId,
      disposition: 'pending',
    })),
  };
}

function sameJoinDeclaration(left: JoinState, right: JoinState): boolean {
  return (
    JSON.stringify(left.policy) === JSON.stringify(right.policy) &&
    left.ledger.length === right.ledger.length &&
    left.ledger.every(
      ({ branchId }, index) => branchId === right.ledger[index]?.branchId,
    )
  );
}

function sameLoopDeclaration(left: LoopState, right: LoopState): boolean {
  return (
    left.loopId === right.loopId &&
    left.collection.kind === right.collection.kind &&
    left.collection.reference === right.collection.reference &&
    left.collectionChecksum === right.collectionChecksum &&
    left.collectionSize === right.collectionSize &&
    left.maxIterations === right.maxIterations &&
    left.maxConcurrency === right.maxConcurrency
  );
}

function rootInvocationKey(workflowVersionId: string, nodeId: string): string {
  return createInvocationKey({ workflowVersionId, nodeId });
}

function loopInvocationKey(
  workflowVersionId: string,
  loopId: string,
  ordinal: number,
): string {
  return createInvocationKey({
    workflowVersionId,
    nodeId: loopId,
    iterationPath: [{ loopNodeId: loopId, ordinal }],
  });
}

function assertLoopInvocations(
  workflowVersionId: string,
  loop: LoopState,
  invocations: ReadonlyMap<string, InvocationState>,
): void {
  for (const ordinal of loop.activeOrdinals) {
    const invocation = invocations.get(
      loopInvocationKey(workflowVersionId, loop.loopId, ordinal),
    );
    if (
      invocation === undefined ||
      !['ready', 'running', 'waiting'].includes(invocation.status)
    )
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `active loop iteration ${loop.loopId}:${String(ordinal)} is inconsistent`,
      );
  }
  for (const ordinal of loop.terminalOrdinals) {
    const invocation = invocations.get(
      loopInvocationKey(workflowVersionId, loop.loopId, ordinal),
    );
    if (invocation === undefined || !isTerminalNodeStatus(invocation.status))
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `terminal loop iteration ${loop.loopId}:${String(ordinal)} is inconsistent`,
      );
  }
}

function event(
  name: EngineEventName,
  occurredAt: string,
  invocation?: InvocationState,
  reasonCode?: string,
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
  };
}
