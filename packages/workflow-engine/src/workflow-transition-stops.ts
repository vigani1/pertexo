import { WorkflowEngineError } from './errors.js';
import { compareOrdinal } from './ordering.js';
import { completeLoopIteration } from './scheduling.js';
import { assertNodeTransition } from './transitions.js';
import {
  isSyntheticLegacyLoop,
  isTerminalNodeStatus,
  nodeEventName,
  transitionEvent as event,
  type MutableWorkflowTransition,
} from './workflow-transition-state.js';

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
    for (const initialLoop of [...loops.values()].sort((left, right) =>
      compareOrdinal(left.controlInvocationKey, right.controlInvocationKey),
    )) {
      if (isSyntheticLegacyLoop(initialLoop)) continue;
      let loop = initialLoop;
      for (const ordinal of initialLoop.activeOrdinals) {
        const iterationPath = [
          ...initialLoop.iterationPath,
          { loopNodeId: initialLoop.loopId, ordinal },
        ];
        let iterationFound = false;
        for (const invocation of invocations.values()) {
          if (
            JSON.stringify(invocation.iterationPath ?? []) !==
            JSON.stringify(iterationPath)
          )
            continue;
          iterationFound = true;
          if (isTerminalNodeStatus(invocation.status)) continue;
          const {
            resumeAt: _resumeAt,
            waitKind: _waitKind,
            ...active
          } = invocation;
          void _resumeAt;
          void _waitKind;
          const stopped = { ...active, status: controlStopStatus };
          invocations.set(invocation.invocationKey, stopped);
          eventDrafts.push(
            event(
              controlStopStatus === 'timed_out'
                ? 'node.timed_out'
                : 'node.canceled',
              stoppedAt,
              stopped,
            ),
          );
        }
        if (!iterationFound)
          throw new WorkflowEngineError(
            'loop_state_invalid',
            `active For Each ordinal ${String(ordinal)} has no body invocation`,
          );
        loop = completeLoopIteration(loop, ordinal);
      }
      if (loop.activeOrdinals.length > 0)
        throw new WorkflowEngineError(
          'loop_state_invalid',
          'active For Each ordinals could not be reconciled',
        );
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

  if (deadlineExpired) {
    const timeoutOccurredAt = deadlineOccurredAt ?? occurredAt;
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
      const {
        resumeAt: _resumeAt,
        waitKind: _waitKind,
        ...active
      } = invocation;
      void _resumeAt;
      void _waitKind;
      const stopped = { ...active, status: stoppedStatus };
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
    for (const invocation of invocations.values()) {
      if (
        invocation.status !== 'pending' &&
        invocation.status !== 'ready' &&
        invocation.status !== 'waiting'
      )
        continue;
      assertNodeTransition(invocation.status, 'canceled');
      const {
        resumeAt: _resumeAt,
        waitKind: _waitKind,
        ...active
      } = invocation;
      void _resumeAt;
      void _waitKind;
      const canceled = { ...active, status: 'canceled' as const };
      invocations.set(invocation.invocationKey, canceled);
      eventDrafts.push(event('node.canceled', occurredAt, canceled));
    }
  }
}
