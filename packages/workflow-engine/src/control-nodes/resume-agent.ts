import { agentChildInvocationKey } from '../invocations/agent-invocation.js';
import type { AgentContinuation } from './agent-continuation.js';

type AgentPhase = AgentContinuation['phase'];
type Proposal = Extract<AgentPhase, { kind: 'proposed_call' }>['proposal'];

export type AgentResumption =
  | Readonly<{ kind: 'model_turn'; invocationKey: string }>
  | Readonly<{ kind: 'admit_tool'; invocationKey: string; proposal: Proposal }>
  | Readonly<{ kind: 'observe_tool'; invocationKey: string }>
  | Extract<AgentPhase, { kind: 'approval_wait' | 'completion' }>;

export function resumeAgent(
  workflowVersionId: string,
  { phase, parentInvocationKey, turn }: AgentContinuation,
): AgentResumption {
  switch (phase.kind) {
    case 'model_turn':
      return {
        kind: 'model_turn',
        invocationKey: agentChildInvocationKey(
          workflowVersionId,
          parentInvocationKey,
          {
            turn,
            work: { kind: phase.kind },
          },
        ),
      };
    case 'proposed_call':
      return {
        kind: 'admit_tool',
        invocationKey: toolKey(phase.ordinal, phase.toolAlias),
        proposal: phase.proposal,
      };
    case 'running_tool':
      return {
        kind: 'observe_tool',
        invocationKey: toolKey(phase.ordinal, phase.toolAlias),
      };
    case 'approval_wait':
    case 'completion':
      return phase;
  }

  function toolKey(ordinal: number, toolAlias: string | undefined) {
    return agentChildInvocationKey(workflowVersionId, parentInvocationKey, {
      turn,
      work: { kind: 'tool_call', ordinal },
      ...(toolAlias === undefined ? {} : { toolAlias }),
    });
  }
}
