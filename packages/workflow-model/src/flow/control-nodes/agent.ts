import { boundedNodeJsonRecordSchema } from '@pertexo/node-sdk';
import { z } from 'zod';

export const AGENT_STEP = Object.freeze({ key: 'ai.agent', version: 1 });
export const AGENT_TOOL_LIMITS = Object.freeze({
  aliasCharacters: 64,
  providerCallIdCharacters: 256,
});

export const agentToolCallSchema = z.strictObject({
  id: z.string().min(1).max(AGENT_TOOL_LIMITS.providerCallIdCharacters),
  name: z.string().min(1).max(AGENT_TOOL_LIMITS.aliasCharacters),
  arguments: boundedNodeJsonRecordSchema,
});

export type AgentToolCall = z.output<typeof agentToolCallSchema>;

export function isAgentDefinition(
  definition: Readonly<{ key: string; version: number }> | undefined,
): boolean {
  return (
    definition?.key === AGENT_STEP.key &&
    definition.version === AGENT_STEP.version
  );
}
