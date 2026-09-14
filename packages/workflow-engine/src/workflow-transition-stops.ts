import { WorkflowEngineError } from './errors.js';
import { compareOrdinal } from './ordering.js';
import { sameIterationPath } from './scope.js';
import { completeLoopIteration } from './scheduling.js';
import { assertNodeTransition } from './transitions.js';
import type { InvocationState } from './types.js';
import {
  isSyntheticLegacyLoop,
  isTerminalNodeStatus,
  nodeEventName,
  transitionEvent as event,
  type MutableWorkflowTransition,
} from './workflow-transition-state.js';

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
  void _resumeAt;
  void _waitKind;
  const stopped = { ...active, status };
  state.invocations.set(invocation.invocationKey, stopped);
  state.eventDrafts.push(
    event(
      status === 'timed_out' ? 'node.timed_out' : 'node.canceled',
      status === 'timed_out'
        ? (state.deadlineOccurredAt ?? occurredAt)
        : occurredAt,
      stopped,
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
  const {
    eventDrafts,
    invocations,
    loops,
    cancelRequested,
    deadlineExpired,
    deadlineOccurredAt,
  } = state;
  const controlStopStatus = cancelRequested
    ? ('canceled' as const)
    : deadlineExpired
      ? ('timed_out' as const)
      : undefined;
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
      if (isSyntheticLegacyLoop(initialLoop)) continue;
      let loop = initialLoop;
      for (const ordinal of initialLoop.activeOrdinals) {
        const iterationPath = [
          ...initialLoop.iterationPath,
          { loopNodeId: initialLoop.loopId, ordinal },
        ];
        const iterationInvocations = [...invocations.values()].filter(
          (invocation) =>
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
            return (
              current !== undefined && isTerminalNodeStatus(current.status)
            );
          })
        )
          loop = completeLoopIteration(loop, ordinal);
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
        void _resumeAt;
        void _waitKind;
        const stopped = { ...active, status: terminalStatus };
        invocations.set(control.invocationKey, stopped);
        eventDrafts.push(
          event(
            stopped.status === 'timed_out'
              ? 'node.timed_out'
              : stopped.status === 'canceled'
                ? 'node.canceled'
                : (nodeEventName[stopped.status] ?? 'node.failed'),
            stoppedAt,
            stopped,
          ),
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
