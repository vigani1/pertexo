import { parseCheckpoint, reconstructReadySet } from './checkpoint.js';
import { WorkflowEngineError } from './errors.js';
import { deriveReadyNodes, type SchedulerState } from './graph-scheduler.js';
import { compareOrdinal } from './ordering.js';
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
  NodeRunAdmissionPlan,
  NodeStatus,
  OutputReference,
  WorkflowCheckpoint,
  WorkflowTransitionPlan,
} from './types.js';

export type WorkflowObservation =
  | { readonly kind: 'cursor_only' }
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
      readonly coordinatorDerived?: boolean;
    }
  | {
      readonly kind: 'wait';
      readonly invocationKey: string;
      readonly resumeAt: string;
      readonly coordinatorDerived?: boolean;
    }
  | { readonly kind: 'resume'; readonly invocationKey: string }
  | { readonly kind: 'cancel_requested' }
  | { readonly kind: 'deadline_expired'; readonly occurredAt?: string }
  | {
      readonly kind: 'branch_selected';
      readonly invocationKey: string;
      readonly nodeId: string;
      readonly selectedOutputPort: string;
      readonly coordinatorDerived?: true;
    }
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

export interface AdvanceWorkflowFromSchedulerStateInput {
  readonly checkpoint: WorkflowCheckpoint;
  readonly schedulerState?: SchedulerState;
  readonly observations?: readonly WorkflowObservation[];
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
  /** Production source facts are already durable events and must not be emitted again. */
  readonly persistedObservationCursor?: Readonly<{
    expectedNextEventSequence: number;
    consumedThroughEventSequence: number;
  }>;
  readonly deadlineExpiration?: Readonly<{ readonly occurredAt: string }>;
  readonly dueResumptions?: readonly Readonly<{
    readonly invocationKey: string;
    readonly occurredAt: string;
  }>[];
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

export function advanceWorkflowFromSchedulerState(
  input: AdvanceWorkflowFromSchedulerStateInput,
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
  const current = input.checkpoint;
  const graph = input.schedulerState;
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
  const branchSelections =
    current.schemaVersion === 2 ? [...current.branchSelections] : [];
  let remainingIterationBudget = current.remainingIterationBudget;
  const eventDrafts: Omit<EngineEventPlan, 'sequence'>[] = [];
  const nodeRunAdmissionKeys = new Set<string>();
  const externalFactsArePersisted =
    input.persistedObservationCursor !== undefined;
  if (
    input.persistedObservationCursor !== undefined &&
    input.persistedObservationCursor.expectedNextEventSequence !==
      current.nextEventSequence
  )
    throw new WorkflowEngineError(
      'observation_invalid',
      'persisted observation cursor does not match checkpoint',
    );
  const consumedThroughEventSequence =
    input.persistedObservationCursor?.consumedThroughEventSequence ??
    current.nextEventSequence - 1;
  const consumedObservationCount =
    consumedThroughEventSequence - current.nextEventSequence + 1;
  if (
    consumedObservationCount < 0 ||
    (externalFactsArePersisted &&
      consumedObservationCount !==
        (input.observations ?? []).filter(
          (observation) =>
            !('coordinatorDerived' in observation) ||
            !observation.coordinatorDerived,
        ).length)
  )
    throw new WorkflowEngineError(
      'observation_invalid',
      'persisted observation cursor is invalid',
    );
  let cancelRequested = current.cancelRequested;
  let deadlineExpired = current.deadlineExpired;
  let deadlineOccurredAt = input.deadlineExpiration?.occurredAt;
  if (input.deadlineExpiration !== undefined) deadlineExpired = true;
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
  const observations = externalFactsArePersisted
    ? [...(input.observations ?? [])]
    : [...(input.observations ?? [])].sort(observationOrder);
  for (const observation of observations) {
    if (observation.kind === 'cancel_requested') {
      if (!cancelRequested && !externalFactsArePersisted)
        eventDrafts.push(event('run.cancel_requested', input.occurredAt));
      cancelRequested = true;
    } else if (observation.kind === 'deadline_expired') {
      deadlineExpired = true;
      deadlineOccurredAt = observation.occurredAt ?? input.occurredAt;
    }
  }

  for (const due of input.dueResumptions ?? []) {
    if (cancelRequested || deadlineExpired) continue;
    const existing = invocations.get(due.invocationKey);
    if (existing === undefined)
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `unknown invocation ${due.invocationKey}`,
      );
    if (existing.status === 'ready' || existing.status === 'running') continue;
    assertNodeTransition(existing.status, 'ready');
    const { resumeAt: _, ...rest } = existing;
    void _;
    const resumed = { ...rest, status: 'ready' as const };
    invocations.set(existing.invocationKey, resumed);
    eventDrafts.push(event('node.ready', due.occurredAt, resumed));
    if (runStatus === 'waiting') {
      assertRunTransition(runStatus, 'running');
      runStatus = 'running';
    }
  }

  if (runStatus === 'queued' && !cancelRequested && !deadlineExpired) {
    assertRunTransition(runStatus, 'running');
    runStatus = 'running';
    eventDrafts.push(event('run.started', input.occurredAt));
  }

  for (const observation of observations) {
    if (observation.kind === 'cursor_only') continue;
    if (
      observation.kind === 'cancel_requested' ||
      observation.kind === 'deadline_expired'
    )
      continue;
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
      if (!invocations.has(joinKey)) {
        invocations.set(joinKey, {
          invocationKey: joinKey,
          nodeId: observation.joinId,
          status: 'pending',
          attemptNumber: 0,
        });
        nodeRunAdmissionKeys.add(joinKey);
      }
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
    if (observation.kind === 'branch_selected') {
      if (cancelRequested) continue;
      if (current.schemaVersion !== 2)
        throw new WorkflowEngineError(
          'checkpoint_invalid',
          'branch selection requires checkpoint V2',
        );
      const invocation = invocations.get(observation.invocationKey);
      if (
        invocation?.nodeId !== observation.nodeId ||
        invocation.status !== 'succeeded' ||
        invocation.output === undefined
      )
        throw new WorkflowEngineError(
          'checkpoint_invalid',
          'branch selection requires a succeeded output-bearing invocation',
        );
      const existingSelection = branchSelections.find(
        (selection) =>
          selection.invocationKey === observation.invocationKey &&
          selection.nodeId === observation.nodeId,
      );
      if (existingSelection !== undefined) {
        if (
          existingSelection.selectedOutputPort !==
          observation.selectedOutputPort
        )
          throw new WorkflowEngineError(
            'checkpoint_invalid',
            'branch selection conflicts with the persisted selection',
          );
        continue;
      }
      branchSelections.push({
        invocationKey: observation.invocationKey,
        nodeId: observation.nodeId,
        selectedOutputPort: observation.selectedOutputPort,
      });
      branchSelections.sort(
        (left, right) =>
          compareOrdinal(left.invocationKey, right.invocationKey) ||
          compareOrdinal(left.nodeId, right.nodeId),
      );
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
      if (!invocations.has(loopKey)) {
        invocations.set(loopKey, {
          invocationKey: loopKey,
          nodeId: observation.loopId,
          status: 'pending',
          attemptNumber: 0,
        });
        nodeRunAdmissionKeys.add(loopKey);
      }
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
      if (!externalFactsArePersisted)
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
      nodeRunAdmissionKeys.add(observation.invocationKey);
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
      if (!externalFactsArePersisted || observation.coordinatorDerived)
        eventDrafts.push(
          event(
            observation.coordinatorDerived
              ? 'node.retry_scheduled'
              : 'node.waiting',
            input.occurredAt,
            existing,
            undefined,
            observation.resumeAt,
          ),
        );
      continue;
    }
    if (observation.kind === 'resume') {
      assertNodeTransition(existing.status, 'ready');
      const { resumeAt: _, ...rest } = existing;
      void _;
      const resumed = { ...rest, status: 'ready' as const };
      invocations.set(existing.invocationKey, resumed);
      if (!externalFactsArePersisted)
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
    if (!externalFactsArePersisted || observation.coordinatorDerived)
      eventDrafts.push(
        event(eventName, input.occurredAt, completed, observation.reasonCode),
      );
  }

  if (
    graph?.deriveReadiness === true &&
    !cancelRequested &&
    !deadlineExpired &&
    (runStatus === 'running' || runStatus === 'waiting')
  ) {
    for (const decision of deriveReadyNodes({
      graph,
      workflowVersionId: current.workflowVersionId,
      invocations: [...invocations.values()],
      ...(current.schemaVersion === 2 ? { branchSelections } : {}),
    })) {
      if (coordinatorNodeIds.has(decision.nodeId)) continue;
      const invocation: InvocationState = {
        invocationKey: decision.invocationKey,
        nodeId: decision.nodeId,
        status: decision.disposition,
        attemptNumber: 0,
        ...(decision.branchPath === undefined
          ? {}
          : { branchPath: decision.branchPath }),
      };
      invocations.set(invocation.invocationKey, invocation);
      nodeRunAdmissionKeys.add(invocation.invocationKey);
      eventDrafts.push(
        event(
          decision.disposition === 'ready' ? 'node.ready' : 'node.skipped',
          input.occurredAt,
          invocation,
        ),
      );
    }
  }

  for (const join of [...joins.values()].sort((left, right) =>
    compareOrdinal(left.joinId, right.joinId),
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

  if (!cancelRequested && !deadlineExpired) {
    for (const loop of [...loops.values()].sort((left, right) =>
      compareOrdinal(left.loopId, right.loopId),
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
        nodeRunAdmissionKeys.add(iterationKey);
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

  if (deadlineExpired) {
    const timeoutOccurredAt = deadlineOccurredAt ?? input.occurredAt;
    for (const loop of loops.values()) {
      let updated = loop;
      for (const ordinal of loop.activeOrdinals) {
        const iterationKey = loopInvocationKey(
          current.workflowVersionId,
          loop.loopId,
          ordinal,
        );
        const iteration = invocations.get(iterationKey);
        if (iteration?.status !== 'ready' && iteration?.status !== 'waiting')
          continue;
        const stoppedStatus =
          iteration.status === 'waiting'
            ? ('timed_out' as const)
            : ('canceled' as const);
        assertNodeTransition(iteration.status, stoppedStatus);
        const stopped = { ...iteration, status: stoppedStatus };
        invocations.set(iterationKey, stopped);
        eventDrafts.push(
          event(
            stoppedStatus === 'timed_out' ? 'node.timed_out' : 'node.canceled',
            timeoutOccurredAt,
            stopped,
          ),
        );
        updated = completeLoopIteration(updated, ordinal);
      }
      loops.set(loop.loopId, updated);
    }
    for (const invocation of invocations.values()) {
      if (
        invocation.status !== 'pending' &&
        invocation.status !== 'ready' &&
        invocation.status !== 'waiting'
      )
        continue;
      const stoppedStatus =
        invocation.status === 'waiting'
          ? ('timed_out' as const)
          : ('canceled' as const);
      assertNodeTransition(invocation.status, stoppedStatus);
      const { resumeAt: _, ...withoutResumeAt } = invocation;
      void _;
      const stopped = { ...withoutResumeAt, status: stoppedStatus };
      invocations.set(invocation.invocationKey, stopped);
      eventDrafts.push(
        event(
          stoppedStatus === 'timed_out' ? 'node.timed_out' : 'node.canceled',
          timeoutOccurredAt,
          stopped,
        ),
      );
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
        if (iteration?.status !== 'ready' && iteration?.status !== 'waiting')
          continue;
        assertNodeTransition(iteration.status, 'canceled');
        const { resumeAt: _, ...withoutResumeAt } = iteration;
        void _;
        const canceled = { ...withoutResumeAt, status: 'canceled' as const };
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
      if (
        invocation.status !== 'pending' &&
        invocation.status !== 'ready' &&
        invocation.status !== 'waiting'
      )
        continue;
      if (activeLoopParents.has(invocation.invocationKey)) continue;
      assertNodeTransition(invocation.status, 'canceled');
      const { resumeAt: _, ...withoutResumeAt } = invocation;
      void _;
      const canceled = { ...withoutResumeAt, status: 'canceled' as const };
      invocations.set(invocation.invocationKey, canceled);
      eventDrafts.push(event('node.canceled', input.occurredAt, canceled));
    }
  }

  const ordered = [...invocations.values()].sort((left, right) =>
    compareOrdinal(left.invocationKey, right.invocationKey),
  );
  const readySet = ordered
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey);
  const admittedKeys =
    cancelRequested || deadlineExpired
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
      sideEffectClass: schedulerNodeSideEffectClass(graph, running.nodeId),
    });
  }

  const finalInvocations = [...invocations.values()].sort((left, right) =>
    compareOrdinal(left.invocationKey, right.invocationKey),
  );
  const nonterminal = finalInvocations.filter(({ status }) =>
    ['pending', 'ready', 'running', 'waiting'].includes(status),
  );
  const graphIncomplete =
    graph?.nodes.some(
      ({ id }) => !finalInvocations.some(({ nodeId }) => nodeId === id),
    ) === true;
  const runIsActive =
    runStatus === 'queued' ||
    runStatus === 'running' ||
    runStatus === 'waiting';
  if (runIsActive && nonterminal.length === 0) {
    const terminalStatus = deriveTerminalRunStatus({
      cancelRequested,
      deadlineExpired,
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

  const firstDerivedEventSequence =
    current.nextEventSequence + consumedObservationCount;
  const events = eventDrafts.map((draft, offset) => ({
    ...draft,
    sequence: firstDerivedEventSequence + offset,
  }));
  const checkpoint = parseCheckpoint({
    ...current,
    revision: current.revision + 1,
    runStatus,
    nextEventSequence: firstDerivedEventSequence + events.length,
    cancelRequested,
    deadlineExpired,
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
    ...(current.schemaVersion === 2 ? { branchSelections } : {}),
  });
  const nodeRunAdmissions: NodeRunAdmissionPlan[] = [...nodeRunAdmissionKeys]
    .sort(compareOrdinal)
    .map((invocationKey) => {
      const invocation = invocations.get(invocationKey);
      if (invocation === undefined)
        throw new WorkflowEngineError(
          'checkpoint_invalid',
          `materialized invocation ${invocationKey} is missing`,
        );
      return {
        invocationKey,
        nodeId: invocation.nodeId,
        sideEffectClass: schedulerNodeSideEffectClass(graph, invocation.nodeId),
      };
    });
  return {
    expectedRevision: current.revision,
    expectedNextEventSequence: current.nextEventSequence,
    consumedThroughEventSequence,
    checkpoint,
    events,
    nodeRunAdmissions,
    attempts,
  };
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
  if (left?.kind !== right?.kind) return false;
  if (left === undefined || right === undefined) return true;
  return left.kind === 'inline' && right.kind === 'inline'
    ? left.attemptId === right.attemptId
    : left.kind === 'artifact' && right.kind === 'artifact'
      ? left.artifactId === right.artifactId
      : false;
}

function deriveTerminalRunStatus(input: {
  readonly cancelRequested: boolean;
  readonly deadlineExpired: boolean;
  readonly graphIncomplete: boolean;
  readonly invocations: readonly InvocationState[];
}):
  | Extract<
      WorkflowCheckpoint['runStatus'],
      'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown'
    >
  | undefined {
  const statuses = new Set(input.invocations.map(({ status }) => status));
  if (statuses.has('outcome_unknown')) return 'outcome_unknown';
  if (input.cancelRequested) return 'canceled';
  if (input.deadlineExpired) return 'timed_out';
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
    sameOutputReference(left.collection, right.collection) &&
    left.collectionChecksum === right.collectionChecksum &&
    left.collectionSize === right.collectionSize &&
    left.maxIterations === right.maxIterations &&
    left.maxConcurrency === right.maxConcurrency
  );
}

function rootInvocationKey(workflowVersionId: string, nodeId: string): string {
  return createInvocationKey({ workflowVersionId, nodeId });
}

function schedulerNodeSideEffectClass(
  schedulerState: SchedulerState | undefined,
  nodeId: string,
): AttemptAdmissionPlan['sideEffectClass'] {
  if (schedulerState === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'scheduler state is required for attempt admission',
    );
  const node = schedulerState.nodes.find(({ id }) => id === nodeId);
  if (node === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      `scheduler node ${nodeId} is missing`,
    );
  return node.sideEffectClass;
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
