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

export const AGENT_LIMITS = Object.freeze({
  turns: 5,
  toolCalls: AGENT_TOOL_LIMITS.historyEntries,
  modelDispatches: 8,
  inputTokens: 128_000,
  outputTokens: 8_192,
  costNanoDollars: 250_000_000,
  timeoutMillis: 120_000,
});

export const agentMappedInputSchema = z.strictObject({
  prompt: z.string().min(1).meta({ title: 'Task' }),
  input: boundedNodeJsonRecordSchema.optional().meta({ title: 'Input' }),
});

const alias = z
  .string()
  .min(1)
  .max(AGENT_TOOL_LIMITS.aliasCharacters)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const agentConfigSchema = z.strictObject({
  model: z
    .string()
    .trim()
    .min(1)
    .max(MODEL_IDENTIFIER_MAX_CHARACTERS)
    .meta({ title: 'Model identifier' }),
  tool: z.strictObject({
    alias: alias.meta({ title: 'Tool alias' }),
    description: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_TOOL_LIMITS.descriptionCharacters)
      .meta({ title: 'Tool description' }),
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

export const agentFinalOutputSchema = z.strictObject({ text: z.string() });

export const agentTurnOutputSchema = z.union([
  agentFinalOutputSchema,
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
