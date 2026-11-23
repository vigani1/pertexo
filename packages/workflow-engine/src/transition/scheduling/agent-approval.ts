import type { ApprovalConfig } from '@pertexo/workflow-model';
import type { AgentContinuation } from '../../control-nodes/agent-continuation.js';
import { agentChildInvocationKey } from '../../invocations/agent-invocation.js';
import type { InvocationState } from '../../workflow-execution.js';
import { invocationIdentity } from '../status.js';
import {
  transitionEvent,
  type MutableWorkflowTransition,
} from '../transition-state.js';
import { finishAgentInvocation } from './settle-agent-invocation.js';

export function openAgentApproval(
  state: MutableWorkflowTransition,
  child: InvocationState,
  {
    agent,
    phase,
    config,
  }: Readonly<{
    agent: AgentContinuation;
    phase: Extract<AgentContinuation['phase'], { kind: 'proposed_call' }>;
    config: ApprovalConfig;
  }>,
  occurredAt: string,
) {
  // Each model turn has its own durable invocation and successful proposal.
  const { output: _proposal, ...identity } = invocationIdentity(child);
  const waiting = {
    ...identity,
    status: 'waiting',
    waitKind: 'human_task',
  } as const;
  state.invocations.set(child.invocationKey, waiting);
  state.agentTaskIntents.push({
    kind: 'approval',
    config: { ...config, onExpiry: 'continue' },
    invocationKey: child.invocationKey,
    deadlineAt: agent.deadlineAt,
  });
  state.eventDrafts.push(
    transitionEvent('node.waiting', occurredAt, { invocation: waiting }),
  );
  state.agents.set(agent.parentInvocationKey, {
    ...agent,
    phase: { ...phase, kind: 'approval_wait' },
  });
}

export function resumeAgentApproval(
  state: MutableWorkflowTransition,
  parent: InvocationState,
  {
    agent,
    phase,
  }: Readonly<{
    agent: AgentContinuation;
    phase: Extract<AgentContinuation['phase'], { kind: 'approval_wait' }>;
  }>,
  occurredAt: string,
) {
  const invocationKey = agentChildInvocationKey(
    state.current.workflowVersionId,
    parent.invocationKey,
    {
      turn: agent.turn,
      work: { kind: 'model_turn' },
    },
  );
  const decision = state.agentScheduler?.decisions.get(invocationKey);
  if (Date.parse(occurredAt) >= Date.parse(agent.deadlineAt)) {
    const child = state.invocations.get(invocationKey);
    if (child?.status === 'waiting')
      finishAgentInvocation(state, child, occurredAt, {
        status: 'canceled',
        reasonCode: 'agent.deadline',
      });
    finishAgentInvocation(state, parent, occurredAt, {
      status: 'timed_out',
      reasonCode: 'agent.deadline',
    });
    return;
  }
  if (decision === undefined) return;
  const { ordinal, proposal, toolAlias } = phase;
  if (decision === 'approved') {
    state.agents.set(parent.invocationKey, {
      ...agent,
      phase: {
        kind: 'proposed_call',
        ordinal,
        proposal,
        ...(toolAlias === undefined ? {} : { toolAlias }),
      },
    });
  } else if (decision === 'rejected' || decision === 'expired') {
    state.agents.set(parent.invocationKey, {
      ...agent,
      turn: agent.turn + 1,
      history: [...(agent.history ?? []), { proposal, outcome: decision }],
      phase: { kind: 'model_turn' },
    });
  } else {
    finishAgentInvocation(state, parent, occurredAt, {
      status: decision === 'canceled' ? 'canceled' : 'failed',
      reasonCode:
        decision === 'refused'
          ? 'pending_task.capacity_exceeded'
          : 'agent.child_failed',
    });
    return;
  }
  state.continueAgents = true;
}
