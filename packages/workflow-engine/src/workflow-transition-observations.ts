import { WorkflowEngineError } from './errors.js';
import { compareOrdinal } from './ordering.js';
import {
  completeLoopIteration,
  createLoopState,
  invocationKey as createInvocationKey,
  recordBranchDisposition,
} from './scheduling.js';
import { assertNodeTransition, assertRunTransition } from './transitions.js';
import type {
  InvocationState,
  LoopState,
  WorkflowObservation,
} from './types.js';
import {
  declaredJoin,
  isTerminalNodeStatus,
  nodeEventName,
  rootInvocationKey,
  sameJoinDeclaration,
  sameLoopDeclaration,
  sameOutputReference,
  transitionEvent as event,
  type MutableWorkflowTransition,
} from './workflow-transition-state.js';

function applyJoinDeclaration(
  state: MutableWorkflowTransition,
  observation: Extract<WorkflowObservation, { kind: 'join_declared' }>,
): void {
  if (state.cancelRequested) return;
  const joinInvocationKey =
    observation.joinInvocationKey ??
    rootInvocationKey(state.current.workflowVersionId, observation.joinId);
  const declared = declaredJoin({ ...observation, joinInvocationKey });
  const existingJoin = state.joins.get(joinInvocationKey);
  if (existingJoin !== undefined) {
    if (!sameJoinDeclaration(existingJoin, declared))
      throw new WorkflowEngineError(
        'join_invalid',
        `join ${observation.joinId} conflicts with its declaration`,
      );
    return;
  }
  state.joins.set(joinInvocationKey, declared);
  if (!state.invocations.has(joinInvocationKey)) {
    state.invocations.set(joinInvocationKey, {
      invocationKey: joinInvocationKey,
      nodeId: observation.joinId,
      status: 'pending',
      attemptNumber: 0,
      ...(observation.branchPath === undefined
        ? {}
        : { branchPath: observation.branchPath }),
      ...(observation.iterationPath === undefined
        ? {}
        : { iterationPath: observation.iterationPath }),
    });
    state.nodeRunAdmissionKeys.add(joinInvocationKey);
  }
}

function applyBranchDisposition(
  state: MutableWorkflowTransition,
  observation: Extract<WorkflowObservation, { kind: 'branch_disposition' }>,
): void {
  const join =
    observation.joinInvocationKey === undefined
      ? [...state.joins.values()].find(
          ({ joinId }) => joinId === observation.joinId,
        )
      : state.joins.get(observation.joinInvocationKey);
  if (join === undefined)
    throw new WorkflowEngineError(
      'join_invalid',
      `join ${observation.joinId} is not declared`,
    );
  state.joins.set(
    join.joinInvocationKey === undefined ||
      join.joinInvocationKey === join.joinId
      ? rootInvocationKey(state.current.workflowVersionId, join.joinId)
      : join.joinInvocationKey,
    {
      ...join,
      ledger: recordBranchDisposition(join.ledger, observation.branch),
    },
  );
}

function applyBranchSelection(
  state: MutableWorkflowTransition,
  observation: Extract<WorkflowObservation, { kind: 'branch_selected' }>,
): void {
  if (state.cancelRequested) return;
  if (state.current.schemaVersion !== 2)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'branch selection requires checkpoint V2',
    );
  const invocation = state.invocations.get(observation.invocationKey);
  if (
    invocation?.nodeId !== observation.nodeId ||
    invocation.status !== 'succeeded' ||
    invocation.output === undefined
  )
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'branch selection requires a succeeded output-bearing invocation',
    );
  const existingSelection = state.branchSelections.find(
    (selection) =>
      selection.invocationKey === observation.invocationKey &&
      selection.nodeId === observation.nodeId,
  );
  if (existingSelection !== undefined) {
    if (existingSelection.selectedOutputPort !== observation.selectedOutputPort)
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        'branch selection conflicts with the persisted selection',
      );
    return;
  }
  state.branchSelections.push({
    invocationKey: observation.invocationKey,
    nodeId: observation.nodeId,
    selectedOutputPort: observation.selectedOutputPort,
  });
  state.branchSelections.sort(
    (left, right) =>
      compareOrdinal(left.invocationKey, right.invocationKey) ||
      compareOrdinal(left.nodeId, right.nodeId),
  );
}

function applyLoopStart(
  state: MutableWorkflowTransition,
  observation: Extract<WorkflowObservation, { kind: 'loop_started' }>,
  occurredAt: string,
): void {
  if (state.cancelRequested) return;
  if (
    state.current.schemaVersion === 1 &&
    (observation.controlInvocationKey !== undefined ||
      observation.branchPath !== undefined ||
      observation.iterationPath !== undefined ||
      observation.bodyRootNodeIds !== undefined ||
      observation.bodySinkNodeId !== undefined)
  )
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'structured For Each requires checkpoint V2',
    );
  const controlInvocationKey =
    observation.controlInvocationKey ??
    rootInvocationKey(state.current.workflowVersionId, observation.loopId);
  const existingLoop = state.loops.get(controlInvocationKey);
  if (existingLoop !== undefined) {
    const declared = createLoopState({
      ...observation,
      controlInvocationKey,
      remainingIterationBudget: Math.max(
        state.remainingIterationBudget,
        observation.collectionSize,
      ),
    });
    if (!sameLoopDeclaration(existingLoop, declared))
      throw new WorkflowEngineError(
        'loop_state_invalid',
        `loop ${observation.loopId} conflicts with its declaration`,
      );
    return;
  }
  let declared: LoopState;
  try {
    declared = createLoopState({
      ...observation,
      controlInvocationKey,
      remainingIterationBudget: state.remainingIterationBudget,
    });
  } catch (error) {
    if (
      !(error instanceof WorkflowEngineError) ||
      error.code !== 'loop_limit_exceeded'
    )
      throw error;
    const control = state.invocations.get(controlInvocationKey);
    if (control?.status !== 'running')
      throw new WorkflowEngineError(
        'loop_state_invalid',
        'For Each control is not running',
      );
    const failed = { ...control, status: 'failed' as const };
    state.invocations.set(controlInvocationKey, failed);
    state.eventDrafts.push(
      event('node.failed', occurredAt, failed, 'loop_limit_exceeded'),
    );
    return;
  }
  state.loops.set(declared.controlInvocationKey, declared);
  state.remainingIterationBudget -= declared.collectionSize;
  if (!state.invocations.has(controlInvocationKey)) {
    state.invocations.set(controlInvocationKey, {
      invocationKey: controlInvocationKey,
      nodeId: observation.loopId,
      status: 'pending',
      attemptNumber: 0,
    });
    state.nodeRunAdmissionKeys.add(controlInvocationKey);
    return;
  }
  const control = state.invocations.get(controlInvocationKey);
  if (control?.status !== 'running')
    throw new WorkflowEngineError(
      'loop_state_invalid',
      'For Each control is not running',
    );
  assertNodeTransition(control.status, 'waiting');
  state.invocations.set(controlInvocationKey, {
    ...control,
    status: 'waiting',
    output: observation.collection,
  });
}

function applyLoopCompletion(
  state: MutableWorkflowTransition,
  observation: Extract<
    WorkflowObservation,
    { kind: 'loop_iteration_completed' }
  >,
  occurredAt: string,
): void {
  const loop =
    observation.controlInvocationKey === undefined
      ? [...state.loops.values()].find(
          ({ loopId }) => loopId === observation.loopId,
        )
      : state.loops.get(observation.controlInvocationKey);
  if (loop === undefined)
    throw new WorkflowEngineError(
      'loop_state_invalid',
      `loop ${observation.loopId} is not declared`,
    );
  const iterationPath = [
    ...loop.iterationPath,
    { loopNodeId: loop.loopId, ordinal: observation.ordinal },
  ];
  const iterationKey =
    observation.invocationKey ??
    createInvocationKey({
      workflowVersionId: state.current.workflowVersionId,
      nodeId: loop.bodySinkNodeId,
      branchPath: loop.branchPath.map(
        ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
      ),
      iterationPath,
    });
  const iteration = state.invocations.get(iterationKey);
  if (iteration === undefined)
    throw new WorkflowEngineError(
      'loop_state_invalid',
      `loop sink ${iterationKey} has no invocation`,
    );
  const status = observation.status ?? 'succeeded';
  if (loop.terminalOrdinals.includes(observation.ordinal)) {
    if (
      iteration.status === status &&
      sameOutputReference(iteration.output, observation.output)
    )
      return;
    assertNodeTransition(iteration.status, status);
    return;
  }
  if (!isTerminalNodeStatus(iteration.status))
    assertNodeTransition(iteration.status, status);
  else if (iteration.status !== status)
    assertNodeTransition(iteration.status, status);
  const completedInvocation: InvocationState = {
    ...iteration,
    status,
    ...(observation.output === undefined ? {} : { output: observation.output }),
  };
  state.invocations.set(iterationKey, completedInvocation);
  const completedLoop = completeLoopIteration(loop, observation.ordinal);
  state.loops.set(
    loop.controlInvocationKey,
    status === 'succeeded' || status === 'skipped'
      ? completedLoop
      : {
          ...completedLoop,
          terminalStatus: loop.terminalStatus ?? status,
        },
  );
  if (
    status !== 'succeeded' &&
    status !== 'skipped' &&
    loop.terminalStatus === undefined
  ) {
    const control = state.invocations.get(loop.controlInvocationKey);
    if (control === undefined || isTerminalNodeStatus(control.status))
      throw new WorkflowEngineError(
        'loop_state_invalid',
        'For Each control cannot accept its first terminal cause',
      );
    assertNodeTransition(control.status, status);
    const stopped = { ...control, status };
    state.invocations.set(control.invocationKey, stopped);
    state.eventDrafts.push(
      event(
        nodeEventName[status] ?? 'node.failed',
        occurredAt,
        stopped,
        observation.reasonCode,
      ),
    );
  }
  const eventName = nodeEventName[status];
  if (eventName === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      `missing event mapping for ${status}`,
    );
  if (!state.externalFactsArePersisted)
    state.eventDrafts.push(
      event(eventName, occurredAt, completedInvocation, observation.reasonCode),
    );
}

function applyInvocationObservation(
  state: MutableWorkflowTransition,
  observation: Extract<
    WorkflowObservation,
    { kind: 'outcome' | 'ready' | 'resume' | 'wait' }
  >,
  occurredAt: string,
): void {
  const existing = state.invocations.get(observation.invocationKey);
  if (observation.kind === 'ready') {
    if (state.cancelRequested || existing !== undefined) return;
    const ready: InvocationState = {
      invocationKey: observation.invocationKey,
      nodeId: observation.nodeId,
      status: 'ready',
      attemptNumber: 0,
      ...(observation.branchPath === undefined
        ? {}
        : { branchPath: observation.branchPath }),
      ...(observation.iterationPath === undefined
        ? {}
        : { iterationPath: observation.iterationPath }),
    };
    state.invocations.set(observation.invocationKey, ready);
    state.nodeRunAdmissionKeys.add(observation.invocationKey);
    state.eventDrafts.push(event('node.ready', occurredAt, ready));
    return;
  }
  if (existing === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      `unknown invocation ${observation.invocationKey}`,
    );
  if (observation.kind === 'wait') {
    assertNodeTransition(existing.status, 'waiting');
    state.invocations.set(existing.invocationKey, {
      ...existing,
      status: 'waiting',
      resumeAt: observation.resumeAt,
      waitKind: observation.waitKind,
      ...(observation.output === undefined
        ? {}
        : { output: observation.output }),
    });
    if (!state.externalFactsArePersisted || observation.coordinatorDerived)
      state.eventDrafts.push(
        event(
          observation.coordinatorDerived
            ? 'node.retry_scheduled'
            : 'node.waiting',
          occurredAt,
          existing,
          undefined,
          observation.resumeAt,
        ),
      );
    return;
  }
  if (observation.kind === 'resume') {
    assertNodeTransition(existing.status, 'ready');
    const { resumeAt: _, ...rest } = existing;
    void _;
    const resumed = { ...rest, status: 'ready' as const };
    state.invocations.set(existing.invocationKey, resumed);
    if (!state.externalFactsArePersisted)
      state.eventDrafts.push(event('node.ready', occurredAt, resumed));
    if (state.runStatus === 'waiting') {
      assertRunTransition(state.runStatus, 'running');
      state.runStatus = 'running';
    }
    return;
  }
  if (isTerminalNodeStatus(existing.status)) {
    if (
      existing.status === observation.status &&
      sameOutputReference(existing.output, observation.output)
    )
      return;
    assertNodeTransition(existing.status, observation.status);
    return;
  }
  if (existing.status === 'waiting' && existing.resumeAt !== undefined)
    throw new WorkflowEngineError(
      'transition_invalid',
      'ordinary waiting invocation must resume before terminal settlement',
    );
  assertNodeTransition(existing.status, observation.status);
  const completed: InvocationState = {
    ...existing,
    status: observation.status,
    ...(observation.output === undefined ? {} : { output: observation.output }),
  };
  state.invocations.set(existing.invocationKey, completed);
  const eventName = nodeEventName[observation.status];
  if (eventName === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      `missing event mapping for ${observation.status}`,
    );
  if (!state.externalFactsArePersisted || observation.coordinatorDerived)
    state.eventDrafts.push(
      event(eventName, occurredAt, completed, observation.reasonCode),
    );
}

function applyControlFacts(
  state: MutableWorkflowTransition,
  observations: readonly WorkflowObservation[],
  occurredAt: string,
): void {
  for (const observation of observations) {
    if (observation.kind === 'cancel_requested') {
      if (!state.cancelRequested && !state.externalFactsArePersisted)
        state.eventDrafts.push(event('run.cancel_requested', occurredAt));
      state.cancelRequested = true;
    } else if (observation.kind === 'deadline_expired') {
      state.deadlineExpired = true;
      state.deadlineOccurredAt = observation.occurredAt ?? occurredAt;
    }
  }
}

function applyDueResumptions(
  state: MutableWorkflowTransition,
  dueResumptions: readonly Readonly<{
    invocationKey: string;
    occurredAt: string;
  }>[],
): void {
  for (const due of dueResumptions) {
    if (state.cancelRequested || state.deadlineExpired) continue;
    const existing = state.invocations.get(due.invocationKey);
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
    state.invocations.set(existing.invocationKey, resumed);
    state.eventDrafts.push(event('node.ready', due.occurredAt, resumed));
    if (state.runStatus === 'waiting') {
      assertRunTransition(state.runStatus, 'running');
      state.runStatus = 'running';
    }
  }
}

export function applyWorkflowObservations(
  state: MutableWorkflowTransition,
  input: Readonly<{
    dueResumptions: readonly Readonly<{
      invocationKey: string;
      occurredAt: string;
    }>[];
    observations: readonly WorkflowObservation[];
    occurredAt: string;
  }>,
): void {
  applyControlFacts(state, input.observations, input.occurredAt);
  applyDueResumptions(state, input.dueResumptions);
  if (
    state.runStatus === 'queued' &&
    !state.cancelRequested &&
    !state.deadlineExpired
  ) {
    assertRunTransition(state.runStatus, 'running');
    state.runStatus = 'running';
    state.eventDrafts.push(event('run.started', input.occurredAt));
  }
  for (const observation of input.observations) {
    switch (observation.kind) {
      case 'cursor_only':
      case 'cancel_requested':
      case 'deadline_expired':
        break;
      case 'join_declared':
        applyJoinDeclaration(state, observation);
        break;
      case 'branch_disposition':
        applyBranchDisposition(state, observation);
        break;
      case 'branch_selected':
        applyBranchSelection(state, observation);
        break;
      case 'loop_started':
        applyLoopStart(state, observation, input.occurredAt);
        break;
      case 'loop_iteration_completed':
        applyLoopCompletion(state, observation, input.occurredAt);
        break;
      default:
        applyInvocationObservation(state, observation, input.occurredAt);
    }
  }
}
