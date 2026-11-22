import { AGENT_STEP } from '@pertexo/workflow-model';
import {
  dataTableValuesSchema,
  type DefinitionIdentity,
} from '@pertexo/node-sdk';
import type { AgentTool } from './agent-scheduler.js';
import type { AgentContinuation } from '../../control-nodes/agent-continuation.js';
import { resumeAgent } from '../../control-nodes/resume-agent.js';
import { readAgentModelReceipt } from '../../control-nodes/agent-model-receipt.js';
import {
  agentTurnTokenEnvelope,
  reserveAgentInference,
  settleAgentTurnUsage,
} from '../../control-nodes/agent-budget.js';
import {
  settleAgentModelTurn,
  settleAgentReadTool,
} from '../../control-nodes/settle-agent-work.js';
import { operationError } from '../../input-checks/engine-values.js';
import type { AgentChild } from '../../invocations/agent-invocation.js';
import type { InvocationState } from '../../workflow-execution.js';
import { invocationIdentity } from '../status.js';
import {
  finishAgentInvocation,
  openAgentApproval,
  resumeAgentApproval,
} from './agent-approval.js';
import {
  isTerminalNodeStatus,
  transitionEvent,
  type MutableWorkflowTransition,
} from '../transition-state.js';
export function reserveAgentAttempt(
  state: MutableWorkflowTransition,
  invocation: InvocationState,
  occurredAt: string,
): boolean {
  const work = invocation.agentWork;
  if (work === undefined) return true;
  const agent = state.agents.get(work.parentInvocationKey);
  if (agent === undefined)
    operationError(
      'workflow_identity_invalid',
      'Agent attempt has no continuation',
    );
  if (work.work.kind !== 'model_turn') {
    if (Date.parse(occurredAt) < Date.parse(agent.deadlineAt)) return true;
    return refuseAgentAttempt(state, invocation, occurredAt, 'agent.deadline');
  }
  const decision = reserveAgentInference(
    agent,
    agentTurnTokenEnvelope,
    occurredAt,
  );
  if (decision.kind === 'reserved') {
    state.agents.set(agent.parentInvocationKey, {
      ...agent,
      budget: decision.budget,
    });
    return true;
  }
  return refuseAgentAttempt(state, invocation, occurredAt, decision.reason);
}

function refuseAgentAttempt(
  state: MutableWorkflowTransition,
  invocation: InvocationState,
  occurredAt: string,
  reasonCode: string,
): false {
  const status = reasonCode === 'agent.deadline' ? 'timed_out' : 'failed';
  const outcome = { status, reasonCode } as const;
  finishAgentInvocation(state, invocation, occurredAt, outcome);
  const work = invocation.agentWork;
  const parent =
    work === undefined
      ? undefined
      : state.invocations.get(work.parentInvocationKey);
  if (parent !== undefined)
    finishAgentInvocation(state, parent, occurredAt, outcome);
  return false;
}

export function advanceAgents(
  state: MutableWorkflowTransition,
  occurredAt: string,
) {
  const scheduler = state.agentScheduler;
  if (scheduler === undefined || state.cancelRequested || state.deadlineExpired)
    return;
  for (const parent of state.invocations.values()) {
    if (parent.agentWork !== undefined || isTerminalNodeStatus(parent.status))
      continue;
    const tool = scheduler.tools.get(parent.nodeId);
    if (tool === undefined) continue;
    let agent = state.agents.get(parent.invocationKey);
    if (agent === undefined && parent.status === 'ready') {
      const modelRates = scheduler.rates(tool.model);
      if (modelRates === undefined) {
        finishAgentInvocation(state, parent, occurredAt, {
          status: 'failed',
          reasonCode: 'agent.accounting',
        });
        continue;
      }
      state.invocations.set(parent.invocationKey, {
        ...invocationIdentity(parent),
        status: 'pending',
      });
      agent = {
        parentInvocationKey: parent.invocationKey,
        deadlineAt: new Date(
          Date.parse(occurredAt) + tool.timeoutMillis,
        ).toISOString(),
        modelRates,
        budget: {
          dispatches: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCost: 0,
        },
        turn: 1,
        phase: { kind: 'model_turn' },
      };
      state.agents.set(parent.invocationKey, agent);
    }
    if (agent !== undefined)
      advanceAgent(state, parent, { agent, tool }, occurredAt);
  }
}

function advanceAgent(
  state: MutableWorkflowTransition,
  parent: InvocationState,
  { agent, tool }: Readonly<{ agent: AgentContinuation; tool: AgentTool }>,
  occurredAt: string,
) {
  const next = resumeAgent(state.current.workflowVersionId, agent);
  if (next.kind === 'completion') return;
  if (next.kind === 'approval_wait') {
    resumeAgentApproval(state, parent, { agent, phase: next }, occurredAt);
    return;
  }
  const child = state.invocations.get(next.invocationKey);
  if (child === undefined) {
    admitAgentWork(state, parent, { agent, tool, next }, occurredAt);
    return;
  }
  if (!isTerminalNodeStatus(child.status)) return;
  if (child.status !== 'succeeded') {
    finishAgentInvocation(state, parent, occurredAt, {
      status: child.status === 'skipped' ? 'failed' : child.status,
      reasonCode: 'agent.child_failed',
    });
    return;
  }
  settleAgentChild(
    state,
    parent,
    { agent, tool, child, modelTurn: next.kind === 'model_turn' },
    occurredAt,
  );
}

function settleAgentChild(
  state: MutableWorkflowTransition,
  parent: InvocationState,
  {
    agent,
    tool,
    child,
    modelTurn,
  }: Readonly<{
    agent: AgentContinuation;
    tool: AgentTool;
    child: InvocationState;
    modelTurn: boolean;
  }>,
  occurredAt: string,
) {
  if (child.output?.kind !== 'inline')
    operationError(
      'observation_invalid',
      'Agent work requires an inline receipt',
    );
  const receipt = modelTurn
    ? readAgentModelReceipt(
        state.agentScheduler?.outputs ?? [],
        child.invocationKey,
        child.output,
      )
    : undefined;
  const decision =
    receipt === undefined
      ? settleAgentReadTool(agent, child.output)
      : settleModelReceipt(agent, receipt, tool.alias);
  if (decision.kind === 'refused') {
    finishAgentInvocation(state, parent, occurredAt, {
      status: 'failed',
      reasonCode: decision.reason,
    });
    return;
  }
  if (receipt?.kind === 'proposal' && tool.policy.effect === 'write') {
    if (
      Object.keys(receipt.call.arguments).some(
        (field) => !tool.policy.inputFields.includes(field),
      ) ||
      !dataTableValuesSchema.safeParse(receipt.call.arguments.values).success
    ) {
      finishAgentInvocation(state, parent, occurredAt, {
        status: 'failed',
        reasonCode: 'agent.tool_arguments',
      });
      return;
    }
    if (
      tool.approval !== undefined &&
      decision.agent.phase.kind === 'proposed_call'
    ) {
      openAgentApproval(
        state,
        child,
        {
          agent: decision.agent,
          phase: decision.agent.phase,
          config: tool.approval,
        },
        occurredAt,
      );
      return;
    }
  }
  state.agents.set(parent.invocationKey, decision.agent);
  if (decision.agent.phase.kind === 'completion') {
    if (receipt?.kind !== 'final')
      operationError(
        'observation_invalid',
        'Agent completion requires a final model turn',
      );
    const succeeded = {
      ...invocationIdentity(parent),
      status: 'succeeded' as const,
      output: decision.agent.phase.output,
    };
    state.invocations.set(parent.invocationKey, succeeded);
    state.agentOutputs.set(parent.invocationKey, {
      nodeId: parent.nodeId,
      value: receipt.value,
    });
    state.eventDrafts.push(
      transitionEvent('node.succeeded', occurredAt, { invocation: succeeded }),
    );
  } else {
    state.continueAgents = true;
  }
}

function settleModelReceipt(
  agent: AgentContinuation,
  receipt: ReturnType<typeof readAgentModelReceipt>,
  alias: string,
) {
  const usage = settleAgentTurnUsage(agent, receipt.usage);
  if (usage.kind === 'refused') return usage;
  return settleAgentModelTurn(
    { ...agent, budget: usage.budget },
    receipt,
    alias,
  );
}

function admitAgentWork(
  state: MutableWorkflowTransition,
  parent: InvocationState,
  {
    agent,
    tool,
    next,
  }: Readonly<{
    agent: AgentContinuation;
    tool: AgentTool;
    next: Extract<ReturnType<typeof resumeAgent>, { invocationKey: string }>;
  }>,
  occurredAt: string,
) {
  if (Date.parse(occurredAt) >= Date.parse(agent.deadlineAt)) {
    finishAgentInvocation(state, parent, occurredAt, {
      status: 'timed_out',
      reasonCode: 'agent.deadline',
    });
  } else if (next.kind === 'model_turn') {
    admitChild(
      state,
      parent,
      {
        agent,
        invocationKey: next.invocationKey,
        work: { kind: 'model_turn' },
        definition: AGENT_STEP,
      },
      occurredAt,
    );
  } else if (
    next.kind === 'admit_tool' &&
    agent.phase.kind === 'proposed_call'
  ) {
    admitChild(
      state,
      parent,
      {
        agent,
        invocationKey: next.invocationKey,
        work: { kind: 'tool_call', ordinal: agent.phase.ordinal },
        definition: tool.node.definition,
        alias: tool.alias,
      },
      occurredAt,
    );
    state.agents.set(parent.invocationKey, {
      ...agent,
      phase: { ...agent.phase, kind: 'running_tool' },
    });
  }
}

function admitChild(
  state: MutableWorkflowTransition,
  parent: InvocationState,
  {
    agent: { parentInvocationKey, turn },
    invocationKey,
    work,
    ...attribution
  }: Readonly<{
    agent: AgentContinuation;
    invocationKey: string;
    work: AgentChild['work'];
    definition: DefinitionIdentity;
    alias?: string;
  }>,
  occurredAt: string,
) {
  const agentWork = { parentInvocationKey, turn, work };
  const invocation: InvocationState = {
    ...invocationIdentity(parent),
    invocationKey,
    status: 'ready',
    attemptNumber: 0,
    agentWork,
  };
  state.invocations.set(invocationKey, invocation);
  state.nodeRunAdmissionKeys.add(invocationKey);
  state.eventDrafts.push({
    ...transitionEvent('node.ready', occurredAt, { invocation }),
    agentWork: { ...agentWork, ...attribution },
  });
}
