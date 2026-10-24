import { selectFailureHandler } from '../failure-routing/selection.js';
import { WorkflowEngineError } from '../errors.js';
import { compareOrdinal } from '@pertexo/workflow-model';
import { recordBranchDisposition } from './scheduling/loops.js';
import { sameOutputReference } from '../output-reference.js';
import { assertNodeTransition, assertRunTransition } from './status.js';
import type { InvocationState, WorkflowObservation } from '../types.js';
import { applyLoopCompletion, applyLoopStart } from './loops.js';
import {
  declaredJoin,
  isTerminalNodeStatus,
  isFinishedIterationScope,
  nodeEventName,
  sameJoinDeclaration,
  transitionEvent as event,
  type MutableWorkflowTransition,
} from './state.js';

function applyJoinDeclaration(
  state: MutableWorkflowTransition,
  observation: Extract<WorkflowObservation, { kind: 'join_declared' }>,
): void {
  if (
    state.cancelRequested ||
    isFinishedIterationScope(state.loops.values(), observation)
  )
    return;
  const joinInvocationKey = observation.joinInvocationKey;
  const declared = declaredJoin(observation);
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
  const join = state.joins.get(observation.joinInvocationKey);
  if (join === undefined)
    throw new WorkflowEngineError(
      'join_invalid',
      `join ${observation.joinId} is not declared`,
    );
  state.joins.set(join.joinInvocationKey, {
    ...join,
    ledger: recordBranchDisposition(join.ledger, observation.branch),
  });
}

function applyBranchSelection(
  state: MutableWorkflowTransition,
  observation: Extract<WorkflowObservation, { kind: 'branch_selected' }>,
): void {
  if (state.cancelRequested) return;
  const invocation = state.invocations.get(observation.invocationKey);
  const invalidBranchInvocation =
    invocation?.nodeId !== observation.nodeId ||
    invocation.status !== 'succeeded' ||
    invocation.output === undefined;
  if (invalidBranchInvocation)
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

function applyInvocationObservation(
  state: MutableWorkflowTransition,
  observation: Extract<
    WorkflowObservation,
    {
      kind:
        | 'outcome'
        | 'ready'
        | 'resume'
        | 'wait'
        | 'call_started'
        | 'task_started';
    }
  >,
  occurredAt: string,
): void {
  const existing = state.invocations.get(observation.invocationKey);
  if (observation.kind === 'ready') {
    applyReadyObservation(state, observation, { existing, occurredAt });
    return;
  }
  if (existing === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      `unknown invocation ${observation.invocationKey}`,
    );
  if (
    observation.kind === 'call_started' ||
    observation.kind === 'task_started'
  ) {
    const waitKind =
      observation.kind === 'call_started' ? 'workflow_call' : 'human_task';
    if (isTerminalNodeStatus(existing.status)) return;
    if (existing.waitKind === waitKind) return;
    assertNodeTransition(existing.status, 'waiting');
    state.invocations.set(existing.invocationKey, {
      ...existing,
      status: 'waiting',
      waitKind,
    });
    state.eventDrafts.push(
      event('node.waiting', occurredAt, { invocation: existing }),
    );
    return;
  }
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
          {
            invocation: existing,
            reasonCode: undefined,
            dueAt: observation.resumeAt,
          },
        ),
      );
    return;
  }
  if (observation.kind === 'resume') {
    assertNodeTransition(existing.status, 'ready');
    const { resumeAt: _, ...rest } = existing;
    const resumed = { ...rest, status: 'ready' as const };
    state.invocations.set(existing.invocationKey, resumed);
    if (!state.externalFactsArePersisted)
      state.eventDrafts.push(
        event('node.ready', occurredAt, { invocation: resumed }),
      );
    if (state.runStatus === 'waiting') {
      assertRunTransition(state.runStatus, 'running');
      state.runStatus = 'running';
    }
    return;
  }
  applyTerminalObservation(state, existing, observation, occurredAt);
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
    const resumed = { ...rest, status: 'ready' as const };
    state.invocations.set(existing.invocationKey, resumed);
    state.eventDrafts.push(
      event('node.ready', due.occurredAt, { invocation: resumed }),
    );
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
  const canStartRun =
    state.runStatus === 'queued' &&
    !state.cancelRequested &&
    !state.deadlineExpired;
  if (canStartRun) {
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
      case 'call_started':
      case 'outcome':
      case 'ready':
      case 'resume':
      case 'task_started':
      case 'wait':
      default:
        applyInvocationObservation(state, observation, input.occurredAt);
    }
  }
}

function applyTerminalObservation(
  state: MutableWorkflowTransition,
  existing: InvocationState,
  observation: Extract<WorkflowObservation, { kind: 'outcome' }>,
  occurredAt: string,
): void {
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
  const { waitKind: _waitKind, ...withoutWaitKind } = existing;
  const completed: InvocationState = {
    ...withoutWaitKind,
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
      event(eventName, occurredAt, {
        invocation: completed,
        reasonCode: observation.reasonCode,
      }),
    );
  if (observation.status === 'failed' && observation.failure !== undefined)
    selectFailureHandler(state, completed, observation.failure, occurredAt);
}

function applyReadyObservation(
  state: MutableWorkflowTransition,
  observation: Extract<WorkflowObservation, { kind: 'ready' }>,
  {
    existing,
    occurredAt,
  }: Readonly<{ existing: InvocationState | undefined; occurredAt: string }>,
): void {
  const cannotAdmitReady =
    state.cancelRequested ||
    existing !== undefined ||
    isFinishedIterationScope(state.loops.values(), observation);
  if (cannotAdmitReady) return;
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
  state.eventDrafts.push(
    event('node.ready', occurredAt, { invocation: ready }),
  );
  return;
}
