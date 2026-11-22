import {
  agentToolCallSchema,
  type AgentToolCall,
  type JsonValue,
} from '@pertexo/workflow-model';

export interface AgentToolRequest {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
}

export interface AgentModelContext {
  readonly tools: readonly AgentToolRequest[];
  readonly history: readonly Readonly<{
    call: AgentToolCall;
    result: JsonValue;
  }>[];
}

export function normalizeAgentProposal(candidate: unknown) {
  const proposal = agentToolCallSchema.safeParse(candidate);
  return proposal.success
    ? ({ kind: 'proposal', call: proposal.data } as const)
    : ({ kind: 'invalid_response' } as const);
}
