import type { InvocationState } from '../../workflow-execution.js';
import { invocationIdentity } from '../status.js';
import {
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
