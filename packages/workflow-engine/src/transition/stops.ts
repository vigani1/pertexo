import { WorkflowEngineError } from '../errors.js';
import { compareOrdinal } from '@pertexo/workflow-model';
import { sameIterationPath } from '../scope.js';
import { completeLoopIteration } from './scheduling/loops.js';
import { assertNodeTransition } from './status.js';
import type { InvocationState, LoopState, EngineEventName } from '../types.js';
import {
  isTerminalNodeStatus,
  nodeEventName,
  transitionEvent as event,
  type MutableWorkflowTransition,
} from './state.js';

type StopStatus = 'canceled' | 'timed_out';
type StoppableInvocation = InvocationState & {
  readonly status: 'pending' | 'ready' | 'waiting';
};

function requestedStopStatus(
  state: Pick<MutableWorkflowTransition, 'cancelRequested' | 'deadlineExpired'>,
  invocationStatus: 'pending' | 'ready' | 'waiting',
): StopStatus | undefined {
  if (state.cancelRequested) return 'canceled';
  if (!state.deadlineExpired) return undefined;
  return invocationStatus === 'waiting' ? 'timed_out' : 'canceled';
}

function stopInvocation(
  state: MutableWorkflowTransition,
  invocation: StoppableInvocation,
  occurredAt: string,
): void {
  const status = requestedStopStatus(state, invocation.status);
  if (status === undefined) return;
  assertNodeTransition(invocation.status, status);
  const { resumeAt: _resumeAt, waitKind: _waitKind, ...active } = invocation;
  const stopped = { ...active, status };
  state.invocations.set(invocation.invocationKey, stopped);
  state.eventDrafts.push(
    event(
      status === 'timed_out' ? 'node.timed_out' : 'node.canceled',
      status === 'timed_out'
        ? (state.deadlineOccurredAt ?? occurredAt)
        : occurredAt,
      { invocation: stopped },
    ),
  );
}

function isStoppableInvocation(
  invocation: InvocationState,
): invocation is StoppableInvocation {
  return (
    invocation.status === 'pending' ||
    invocation.status === 'ready' ||
    invocation.status === 'waiting'
  );
}

function activeNestedLoopControls(
  state: MutableWorkflowTransition,
): ReadonlySet<string> {
  return new Set(
    [...state.loops.values()]
      .filter(({ activeOrdinals }) => activeOrdinals.length > 0)
      .map(({ controlInvocationKey }) => controlInvocationKey),
  );
}

function iterationContainsActiveNestedLoop(
  state: MutableWorkflowTransition,
  invocationKeys: ReadonlySet<string>,
): boolean {
  return [...state.loops.values()].some(
    ({ activeOrdinals, controlInvocationKey }) =>
      activeOrdinals.length > 0 && invocationKeys.has(controlInvocationKey),
  );
}

export function applyWorkflowStops(
  state: MutableWorkflowTransition,
  occurredAt: string,
): void {
  const { eventDrafts, invocations, loops, deadlineOccurredAt } = state;
  const controlStopStatus = requestedControlStop(state);
  if (controlStopStatus !== undefined) {
    const stoppedAt =
      controlStopStatus === 'timed_out'
        ? (deadlineOccurredAt ?? occurredAt)
        : occurredAt;
    for (const initialLoop of [...loops.values()].sort(
      (left, right) =>
        right.iterationPath.length - left.iterationPath.length ||
        compareOrdinal(left.controlInvocationKey, right.controlInvocationKey),
    )) {
      const initialControl = invocations.get(initialLoop.controlInvocationKey);
      // Stopping the run cannot rewrite a loop that already settled. Its
      // successor may not have been admitted by the next coordinator pass yet.
      const alreadySettled =
        initialLoop.activeOrdinals.length === 0 &&
        initialControl !== undefined &&
        isTerminalNodeStatus(initialControl.status);
      if (alreadySettled) continue;
      let loop = initialLoop;
      for (const ordinal of initialLoop.activeOrdinals) {
        loop = stopLoopIteration(state, loop, ordinal, occurredAt);
      }
      if (loop.activeOrdinals.length > 0) {
        loops.set(loop.controlInvocationKey, loop);
        continue;
      }
      loop = {
        ...loop,
        terminalStatus: loop.terminalStatus ?? controlStopStatus,
      };
      loops.set(loop.controlInvocationKey, loop);
      const control = invocations.get(loop.controlInvocationKey);
      if (control !== undefined && !isTerminalNodeStatus(control.status)) {
        const terminalStatus = loop.terminalStatus ?? controlStopStatus;
        const { resumeAt: _resumeAt, waitKind: _waitKind, ...active } = control;
        const stopped = { ...active, status: terminalStatus };
        invocations.set(control.invocationKey, stopped);
        eventDrafts.push(
          event(stoppedControlEvent(stopped.status), stoppedAt, {
            invocation: stopped,
          }),
        );
      }
    }
  }

  const protectedControls = activeNestedLoopControls(state);
  for (const invocation of invocations.values())
    if (
      isStoppableInvocation(invocation) &&
      !protectedControls.has(invocation.invocationKey)
    )
      stopInvocation(state, invocation, occurredAt);
}

function requestedControlStop(
  state: MutableWorkflowTransition,
): StopStatus | undefined {
  if (state.cancelRequested) return 'canceled';
  if (state.deadlineExpired) return 'timed_out';
  return undefined;
}
function stoppedControlEvent(
  status: InvocationState['status'],
): EngineEventName {
  if (status === 'timed_out') return 'node.timed_out';
  if (status === 'canceled') return 'node.canceled';
  return nodeEventName[status] ?? 'node.failed';
}
function stopLoopIteration(
  state: MutableWorkflowTransition,
  loop: LoopState,
  ordinal: number,
  occurredAt: string,
): LoopState {
  const { invocations } = state;
  const iterationPath = [
    ...loop.iterationPath,
    { loopNodeId: loop.loopId, ordinal },
  ];
  const iterationInvocations = [...invocations.values()].filter((invocation) =>
    sameIterationPath(invocation.iterationPath, iterationPath),
  );
  if (iterationInvocations.length === 0)
    throw new WorkflowEngineError(
      'loop_state_invalid',
      `active For Each ordinal ${String(ordinal)} has no body invocation`,
    );
  const protectedControls = activeNestedLoopControls(state);
  for (const invocation of iterationInvocations) {
    if (
      isStoppableInvocation(invocation) &&
      !protectedControls.has(invocation.invocationKey)
    )
      stopInvocation(state, invocation, occurredAt);
  }
  const iterationKeys = new Set(
    iterationInvocations.map(({ invocationKey }) => invocationKey),
  );
  if (
    !iterationContainsActiveNestedLoop(state, iterationKeys) &&
    iterationInvocations.every(({ invocationKey }) => {
      const current = invocations.get(invocationKey);
      return current !== undefined && isTerminalNodeStatus(current.status);
    })
  )
    return completeLoopIteration(loop, ordinal);
  return loop;
}
