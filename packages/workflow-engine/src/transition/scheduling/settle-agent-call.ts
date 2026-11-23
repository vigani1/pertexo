import type { AgentContinuation } from '../../control-nodes/agent-continuation.js';
import { settleAgentTool } from '../../control-nodes/settle-agent-work.js';
import type { InvocationState } from '../../workflow-execution.js';
import type { MutableWorkflowTransition } from '../transition-state.js';
import { finishAgentInvocation } from './settle-agent-invocation.js';

export function settleAgentCall(
  state: MutableWorkflowTransition,
  parent: InvocationState,
  {
    agent,
    child,
  }: Readonly<{ agent: AgentContinuation; child: InvocationState }>,
  occurredAt: string,
) {
  if (Date.parse(occurredAt) >= Date.parse(agent.deadlineAt)) {
    finishAgentInvocation(state, parent, occurredAt, {
      status: 'timed_out',
      reasonCode: 'agent.deadline',
    });
    return;
  }
  const decision = settleAgentTool(
    agent,
    child.output?.kind === 'call'
      ? { child: child.output }
      : {
          childFailure:
            state.eventDrafts.findLast(
              ({ invocationKey, reasonCode }) =>
                invocationKey === child.invocationKey &&
                reasonCode !== undefined,
            )?.reasonCode ?? 'agent.child_failed',
        },
  );
  if (decision.kind === 'refused') {
    finishAgentInvocation(state, parent, occurredAt, {
      status: 'failed',
      reasonCode: decision.reason,
    });
    return;
  }
  state.agents.set(parent.invocationKey, decision.agent);
  state.continueAgents = true;
}
