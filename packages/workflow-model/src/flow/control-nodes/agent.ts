import {
  boundedNodeJsonRecordSchema,
  dataTableConfigSchema,
  dataTableFindConfigSchema,
  FIND_ROWS_V1,
  FIND_ROWS_V2,
  MODEL_IDENTIFIER_MAX_CHARACTERS,
} from '@pertexo/node-sdk';
import { z } from 'zod';
import { callableTypeStructuralSchema } from '../callable/callable-types.js';
import {
  WORKFLOW_CALL,
  workflowCallConfigSchema,
} from '../callable/invocation.js';
import { approvalConfigSchema } from '../pending-tasks/approval.js';
import { PENDING_TASK_LIMITS } from '../pending-tasks/pending-task-limits.js';

export const AGENT_STEP = Object.freeze({ key: 'ai.agent', version: 1 });
export const AGENT_STEP_V2 = Object.freeze({ key: AGENT_STEP.key, version: 2 });
export const AGENT_STEP_V3 = Object.freeze({ key: AGENT_STEP.key, version: 3 });
export const AGENT_FIND_ROWS = FIND_ROWS_V1;
export const AGENT_INSERT_ROW = Object.freeze({
  key: 'core.table_insert',
  version: 1,
});
export const AGENT_SEND_SLACK_MESSAGE = Object.freeze({
  key: 'slack.send_message',
  version: 1,
});
export const AGENT_SLACK_CONNECTION_SLOT = 'slack_bot_token';
const MILLIS_PER_SECOND = 1_000;
const AGENT_TIMEOUT_DEFAULT_MILLIS = 120_000;
export const AGENT_TIMEOUT_MAX_MILLIS =
  (PENDING_TASK_LIMITS.maximumExpirySeconds + 1) * MILLIS_PER_SECOND;
export const AGENT_TOOL_LIMITS = Object.freeze({
  tools: 4,
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

export const agentToolAliasSchema = z
  .string()
  .min(1)
  .max(AGENT_TOOL_LIMITS.aliasCharacters)
  .regex(/^[A-Za-z0-9_-]+$/u);

const toolSetup = z.strictObject({
  alias: agentToolAliasSchema.meta({ title: 'Tool alias' }),
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

const legacyFindTool = toolSetup.extend({
  definition: z.strictObject({
    key: z.literal(FIND_ROWS_V1.key),
    version: z.literal(FIND_ROWS_V1.version),
  }),
});

const idBoundFindTool = toolSetup.extend({
  definition: z.strictObject({
    key: z.literal(FIND_ROWS_V2.key),
    version: z.literal(FIND_ROWS_V2.version),
  }),
  config: dataTableFindConfigSchema,
});

function agentConfig(findTool: typeof legacyFindTool | typeof idBoundFindTool) {
  return z
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
        .meta({ title: 'Agent deadline' })
        .optional(),
      tool: z.union([
        toolSetup.extend({
          definition: z.strictObject({
            key: z.literal(WORKFLOW_CALL.key),
            version: z.literal(WORKFLOW_CALL.version),
          }),
          config: workflowCallConfigSchema.extend({
            input: callableTypeStructuralSchema.refine(
              (type) => type.type === 'object',
            ),
          }),
          writePermission,
        }),
        findTool,
        toolSetup.extend({
          definition: z.strictObject({
            key: z.literal(AGENT_INSERT_ROW.key),
            version: z.literal(AGENT_INSERT_ROW.version),
          }),
          writePermission,
        }),
        toolSetup.extend({
          definition: z.strictObject({
            key: z.literal(AGENT_SEND_SLACK_MESSAGE.key),
            version: z.literal(AGENT_SEND_SLACK_MESSAGE.version),
          }),
          config: z.strictObject({
            channelId: z.string().min(1).meta({ title: 'Slack channel ID' }),
            timeoutMillis: z
              .number()
              .int()
              .positive()
              .meta({ title: 'Slack timeout' }),
          }),
          writePermission,
        }),
      ]),
    })
    .refine(
      ({ tool, timeoutMillis }) => approvalFitsDeadline(tool, timeoutMillis),
      {
        path: ['timeoutMillis'],
        message: 'The Agent deadline must exceed the tool approval expiry.',
      },
    );
}
export const agentConfigV1Schema = agentConfig(legacyFindTool);
export const agentConfigV2Schema = agentConfig(idBoundFindTool);
export const agentConfigSchema = z.union([
  agentConfigV1Schema,
  agentConfigV2Schema,
]);

export type AgentConfig = z.output<typeof agentConfigSchema>;

export const agentConfigV3Schema = z
  .strictObject({
    model: agentConfigV2Schema.shape.model,
    timeoutMillis: agentConfigV2Schema.shape.timeoutMillis,
    tools: z
      .array(agentConfigV2Schema.shape.tool)
      .min(1)
      .max(AGENT_TOOL_LIMITS.tools),
  })
  .refine(
    ({ tools }) =>
      new Set(tools.map(({ alias }) => alias)).size === tools.length,
    {
      path: ['tools'],
      message: 'Choose a unique alias for each Agent tool.',
    },
  )
  .refine(
    ({ tools, timeoutMillis }) =>
      tools.every((tool) => approvalFitsDeadline(tool, timeoutMillis)),
    {
      path: ['timeoutMillis'],
      message: 'The Agent deadline must exceed each tool approval expiry.',
    },
  );

export type AgentToolConfig = AgentConfig['tool'];

function approvalFitsDeadline(
  tool: Readonly<{
    config: unknown;
    writePermission?: z.output<typeof writePermission>;
  }>,
  timeoutMillis: number | undefined,
): boolean {
  return (
    tool.writePermission === undefined ||
    tool.writePermission.kind === 'allow' ||
    (timeoutMillis ?? AGENT_TIMEOUT_DEFAULT_MILLIS) >
      tool.writePermission.config.expiresAfterSeconds * MILLIS_PER_SECOND
  );
}

export function readAgentConfig(
  node: Readonly<{
    definition: Readonly<{ key: string; version: number }>;
    config: unknown;
  }>,
):
  | Readonly<{
      model: string;
      timeoutMillis?: number | undefined;
      tools: readonly AgentToolConfig[];
    }>
  | undefined {
  if (!isAgentDefinition(node.definition)) return undefined;
  if (node.definition.version === AGENT_STEP_V3.version)
    return agentConfigV3Schema.safeParse(node.config).data;
  const schema =
    node.definition.version === AGENT_STEP_V2.version
      ? agentConfigV2Schema
      : agentConfigV1Schema;
  const settings = schema.safeParse(node.config).data;
  if (settings === undefined) return undefined;
  const { tool, ...config } = settings;
  return { ...config, tools: [tool] };
}

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
    (definition.version === AGENT_STEP.version ||
      definition.version === AGENT_STEP_V2.version ||
      definition.version === AGENT_STEP_V3.version)
  );
}

export function agentToolsAllowedWithoutApproval(
  node: Parameters<typeof readAgentConfig>[0],
) {
  return (readAgentConfig(node)?.tools ?? []).filter(
    (tool) =>
      'writePermission' in tool && tool.writePermission.kind === 'allow',
  );
}

const agentTokenRate = z.int().min(0).max(AGENT_LIMITS.costNanoDollars);

export const agentModelRatesSchema = z.record(
  z.string().min(1).max(MODEL_IDENTIFIER_MAX_CHARACTERS),
  z.strictObject({ input: agentTokenRate, output: agentTokenRate }),
);
