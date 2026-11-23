import type {
  InvocationState,
  WorkflowObservation,
} from '../../workflow-execution.js';
import { selectFailureHandler } from '../../failure-routing/selection.js';
import { invocationIdentity } from '../status.js';
import {
  isTerminalNodeStatus,
  nodeEventName,
  transitionEvent,
  type MutableWorkflowTransition,
} from '../transition-state.js';

export function finishAgentInvocation(
  state: MutableWorkflowTransition,
  parent: InvocationState,
  occurredAt: string,
  {
    status,
    reasonCode,
  }: Readonly<{
    status: 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown';
    reasonCode: string;
  }>,
) {
  const invocation = { ...invocationIdentity(parent), status };
  state.invocations.set(parent.invocationKey, invocation);
  state.eventDrafts.push(
    transitionEvent(nodeEventName[status] ?? 'node.failed', occurredAt, {
      invocation,
      reasonCode,
    }),
  );
}

export function settleAgentChildFailure(
  state: MutableWorkflowTransition,
  child: InvocationState,
  observation: Extract<WorkflowObservation, { kind: 'outcome' }>,
  occurredAt: string,
): void {
  const work = child.agentWork;
  const parent =
    work === undefined
      ? undefined
      : state.invocations.get(work.parentInvocationKey);
  if (parent === undefined || isTerminalNodeStatus(parent.status)) return;
  const { status, failure, reasonCode } = observation;
  if (status === 'outcome_unknown') {
    finishAgentInvocation(state, parent, occurredAt, {
      status,
      reasonCode: reasonCode ?? 'agent.child_failed',
    });
  } else if (status === 'failed' && failure !== undefined) {
    finishAgentInvocation(state, parent, occurredAt, {
      status,
      reasonCode: failure.safeErrorCode,
    });
    selectFailureHandler(state, child, failure, occurredAt);
  }
}
