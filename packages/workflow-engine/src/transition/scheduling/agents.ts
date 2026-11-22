import {
  AGENT_LIMITS,
  AGENT_STEP,
  agentTurnOutputSchema,
  type JsonValue,
} from '@pertexo/workflow-model';
import type { DefinitionIdentity } from '@pertexo/node-sdk';
import type { pinAgentTool } from '../../compilation/agent-tools.js';
import {
  executableAgentTool,
  executionNodes,
} from '../../compilation/verified-executable.js';
import type { CompiledWorkflowExecutable } from '../../compilation/workflow-executable.js';
import { isAgentWorkInvocationKey } from '../../invocations/agent-invocation.js';
import { parseCompletedOutputItems } from '../../observation/coordinator-output.js';
import type {
  AgentContinuation,
  AgentModelRates,
} from '../../control-nodes/agent-continuation.js';
import { resumeAgent } from '../../control-nodes/resume-agent.js';
import {
  agentTurnTokenEnvelope,
  reserveAgentInference,
  settleAgentTurnUsage,
} from '../../control-nodes/agent-budget.js';
import {
  settleAgentModelTurn,
  settleAgentReadTool,
} from '../../control-nodes/settle-agent-work.js';
import {
  isJsonRecord,
  operationError,
} from '../../input-checks/engine-values.js';
import type { AgentChild } from '../../invocations/agent-invocation.js';
import type { InvocationState } from '../../workflow-execution.js';
import { invocationIdentity } from '../status.js';
import {
  isTerminalNodeStatus,
  nodeEventName,
  transitionEvent,
  type MutableWorkflowTransition,
} from '../transition-state.js';
type AgentTool = NonNullable<ReturnType<typeof pinAgentTool>>;
export type AgentScheduler = Readonly<{
  tools: ReadonlyMap<string, AgentTool>;
  rates: (model: string) => AgentModelRates | undefined;
  outputs: readonly JsonValue[];
}>;
export function agentSchedulerFor({
  executable,
  agentModelRates,
  completedOutputs,
}: Readonly<{
  executable: CompiledWorkflowExecutable;
  agentModelRates?: AgentScheduler['rates'];
  completedOutputs?: unknown;
}>): AgentScheduler | undefined {
  const tools = new Map(
    executionNodes(executable).flatMap(({ id }) => {
      const tool = executableAgentTool(executable, id);
      return tool === undefined ? [] : [[id, tool] as const];
    }),
  );
  return tools.size === 0
    ? undefined
    : {
        tools,
        rates: agentModelRates ?? (() => undefined),
        outputs: parseCompletedOutputItems(completedOutputs),
      };
}
export function graphStepOutputs(
  items: readonly JsonValue[],
): readonly JsonValue[] {
  return items.filter(
    (item) =>
      !isJsonRecord(item) ||
      typeof item.invocationKey !== 'string' ||
      !isAgentWorkInvocationKey(item.invocationKey),
  );
}

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
  finishParent(state, invocation, occurredAt, outcome);
  const work = invocation.agentWork;
  const parent =
    work === undefined
      ? undefined
      : state.invocations.get(work.parentInvocationKey);
  if (parent !== undefined) finishParent(state, parent, occurredAt, outcome);
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
        finishParent(state, parent, occurredAt, {
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
          Date.parse(occurredAt) + AGENT_LIMITS.timeoutMillis,
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
  if (next.kind === 'approval_wait' || next.kind === 'completion') return;
  const child = state.invocations.get(next.invocationKey);
  if (child === undefined) {
    admitAgentWork(state, parent, { agent, tool, next }, occurredAt);
    return;
  }
  if (!isTerminalNodeStatus(child.status)) return;
  if (child.status !== 'succeeded') {
    finishParent(state, parent, occurredAt, {
      status: child.status === 'skipped' ? 'failed' : child.status,
      reasonCode: 'agent.child_failed',
    });
    return;
  }
  if (child.output?.kind !== 'inline')
    operationError(
      'observation_invalid',
      'Agent work requires an inline receipt',
    );
  const receipt =
    next.kind === 'model_turn'
      ? modelReceipt(state, child.invocationKey, child.output)
      : undefined;
  const usage =
    receipt === undefined
      ? undefined
      : settleAgentTurnUsage(agent, receipt.usage);
  if (usage?.kind === 'refused') {
    finishParent(state, parent, occurredAt, {
      status: 'failed',
      reasonCode: usage.reason,
    });
    return;
  }
  const decision =
    receipt === undefined
      ? settleAgentReadTool(agent, child.output)
      : settleAgentModelTurn(
          { ...agent, budget: usage?.budget ?? agent.budget },
          receipt,
          tool.alias,
        );
  if (decision.kind === 'refused') {
    finishParent(state, parent, occurredAt, {
      status: 'failed',
      reasonCode: decision.reason,
    });
    return;
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
    finishParent(state, parent, occurredAt, {
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

function modelReceipt(
  state: MutableWorkflowTransition,
  invocationKey: string,
  output: Extract<NonNullable<InvocationState['output']>, { kind: 'inline' }>,
) {
  const material = state.agentScheduler?.outputs.find(
    (item) =>
      isJsonRecord(item) &&
      item.attemptId === output.attemptId &&
      item.invocationKey === invocationKey,
  );
  const record = isJsonRecord(material) ? material : undefined;
  const parsed = agentTurnOutputSchema.safeParse(record?.value);
  if (!parsed.success)
    operationError('observation_invalid', 'Agent model receipt is invalid');
  const reported =
    typeof record?.inputTokens === 'number' &&
    typeof record.outputTokens === 'number'
      ? { inputTokens: record.inputTokens, outputTokens: record.outputTokens }
      : undefined;
  return 'proposal' in parsed.data
    ? {
        kind: 'proposal' as const,
        call: parsed.data.proposal,
        output,
        usage: reported,
      }
    : { kind: 'final' as const, value: parsed.data, output, usage: reported };
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

function finishParent(
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
