import {
  validateCallableValue,
  type AgentToolCall,
} from '@pertexo/workflow-model';
import { dataTableValuesSchema } from '@pertexo/node-sdk';
import type { AgentContinuation } from '../../control-nodes/agent-continuation.js';
import type { readAgentModelReceipt } from '../../control-nodes/agent-model-receipt.js';
import type { InvocationState } from '../../workflow-execution.js';
import type { MutableWorkflowTransition } from '../transition-state.js';
import { openAgentApproval } from './agent-approval.js';
import type { AgentTool } from './agent-scheduler.js';
import { finishAgentInvocation } from './settle-agent-invocation.js';

export function acceptAgentProposal(
  state: MutableWorkflowTransition,
  {
    parent,
    child,
    agent,
    tool,
    receipt,
  }: Readonly<{
    parent: InvocationState;
    child: InvocationState;
    agent: AgentContinuation;
    tool: AgentTool;
    receipt: Extract<
      ReturnType<typeof readAgentModelReceipt>,
      { kind: 'proposal' }
    >;
  }>,
  occurredAt: string,
): boolean {
  const { phase } = agent;
  if (phase.kind !== 'proposed_call') return true;
  if (
    receipt.admission?.kind === 'refused' ||
    (receipt.admission === undefined &&
      !validLegacyToolArguments(tool, receipt.call.arguments))
  ) {
    finishAgentInvocation(state, parent, occurredAt, {
      status: 'failed',
      reasonCode: 'agent.tool_arguments',
    });
    return false;
  }
  if (tool.approval === undefined) return true;
  openAgentApproval(
    state,
    child,
    { agent, phase, config: tool.approval },
    occurredAt,
  );
  return false;
}

function validLegacyToolArguments(
  tool: AgentTool,
  args: AgentToolCall['arguments'],
) {
  if (tool.callable !== undefined)
    return validateCallableValue(tool.callable.input, args) === undefined;
  return (
    Object.keys(args).every((field) =>
      tool.policy.inputFields.includes(field),
    ) &&
    (!('table' in tool.node.config) ||
      tool.policy.effect === 'read' ||
      dataTableValuesSchema.safeParse(args.values).success)
  );
}
