import {
  boundedNodeJsonRecordSchema,
  dataTableConfigSchema,
  MODEL_IDENTIFIER_MAX_CHARACTERS,
} from '@pertexo/node-sdk';
import { z } from 'zod';
import { approvalConfigSchema } from '../pending-tasks/approval.js';
import { PENDING_TASK_LIMITS } from '../pending-tasks/pending-task-limits.js';

export const AGENT_STEP = Object.freeze({ key: 'ai.agent', version: 1 });
export const AGENT_FIND_ROWS = Object.freeze({
  key: 'core.table_find',
  version: 1,
});
export const AGENT_INSERT_ROW = Object.freeze({
  key: 'core.table_insert',
  version: 1,
});
const MILLIS_PER_SECOND = 1_000;
export const AGENT_TIMEOUT_DEFAULT_MILLIS = 120_000;
export const AGENT_TIMEOUT_MAX_MILLIS =
  (PENDING_TASK_LIMITS.maximumExpirySeconds + 1) * MILLIS_PER_SECOND;
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
  timeoutMillis: AGENT_TIMEOUT_DEFAULT_MILLIS,
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

const toolSetup = z.strictObject({
  alias: alias.meta({ title: 'Tool alias' }),
  description: z
    .string()
    .trim()
    .min(1)
    .max(AGENT_TOOL_LIMITS.descriptionCharacters)
    .meta({ title: 'Tool description' }),
  config: dataTableConfigSchema,
});

const writePermission = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('allow') }),
  z.strictObject({
    kind: z.literal('approval'),
    config: approvalConfigSchema.omit({ onExpiry: true }),
  }),
]);

export const agentConfigSchema = z
  .strictObject({
    model: z
      .string()
      .trim()
      .min(1)
      .max(MODEL_IDENTIFIER_MAX_CHARACTERS)
      .meta({ title: 'Model identifier' }),
    timeoutMillis: z
      .number()
      .int()
      .positive()
      .max(AGENT_TIMEOUT_MAX_MILLIS)
      .optional(),
    tool: z.union([
      toolSetup.extend({
        definition: z.strictObject({
          key: z.literal(AGENT_FIND_ROWS.key),
          version: z.literal(AGENT_FIND_ROWS.version),
        }),
      }),
      toolSetup.extend({
        definition: z.strictObject({
          key: z.literal(AGENT_INSERT_ROW.key),
          version: z.literal(AGENT_INSERT_ROW.version),
        }),
        writePermission,
      }),
    ]),
  })
  .refine(
    ({ tool, timeoutMillis }) =>
      !('writePermission' in tool) ||
      tool.writePermission.kind === 'allow' ||
      (timeoutMillis ?? AGENT_TIMEOUT_DEFAULT_MILLIS) >
        tool.writePermission.config.expiresAfterSeconds * MILLIS_PER_SECOND,
    {
      path: ['timeoutMillis'],
      message: 'The Agent deadline must exceed the tool approval expiry.',
    },
  );

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
