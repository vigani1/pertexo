import {
  boundedNodeJsonRecordSchema,
  dataTableConfigSchema,
  MODEL_IDENTIFIER_MAX_CHARACTERS,
} from '@pertexo/node-sdk';
import { z } from 'zod';

export const AGENT_STEP = Object.freeze({ key: 'ai.agent', version: 1 });
export const AGENT_FIND_ROWS = Object.freeze({
  key: 'core.table_find',
  version: 1,
});
export const AGENT_TOOL_LIMITS = Object.freeze({
  aliasCharacters: 64,
  providerCallIdCharacters: 256,
  descriptionCharacters: 512,
  historyEntries: 4,
  resultBytes: 8_192,
  requestBytes: 24_576,
  outputTokens: 1_024,
});

const alias = z
  .string()
  .min(1)
  .max(AGENT_TOOL_LIMITS.aliasCharacters)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const agentConfigSchema = z.strictObject({
  model: z.string().trim().min(1).max(MODEL_IDENTIFIER_MAX_CHARACTERS),
  tool: z.strictObject({
    alias,
    description: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_TOOL_LIMITS.descriptionCharacters),
    definition: z.strictObject({
      key: z.literal(AGENT_FIND_ROWS.key),
      version: z.literal(AGENT_FIND_ROWS.version),
    }),
    config: dataTableConfigSchema,
  }),
});

export type AgentConfig = z.output<typeof agentConfigSchema>;

export const agentToolCallSchema = z.strictObject({
  id: z.string().min(1).max(AGENT_TOOL_LIMITS.providerCallIdCharacters),
  name: z.string().min(1).max(AGENT_TOOL_LIMITS.aliasCharacters),
  arguments: boundedNodeJsonRecordSchema,
});

export type AgentToolCall = z.output<typeof agentToolCallSchema>;

export const agentTurnOutputSchema = z.union([
  z.strictObject({ text: z.string() }),
  z.strictObject({ proposal: agentToolCallSchema }),
]);

export function isAgentDefinition(
  definition: Readonly<{ key: string; version: number }> | undefined,
): boolean {
  return (
    definition?.key === AGENT_STEP.key &&
    definition.version === AGENT_STEP.version
  );
}
