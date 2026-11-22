import {
  boundedNodeJsonRecordSchema,
  generateSchemaDocument,
  type NodeManifest,
} from '@pertexo/node-sdk';
import { DISPATCH_AWARE_EXECUTOR_ABI_VERSION } from '@pertexo/node-sdk/server';
import {
  AGENT_STEP,
  AGENT_SLACK_CONNECTION_SLOT,
  AGENT_TOOL_LIMITS,
  agentMappedInputSchema,
  agentConfigSchema,
  agentToolCallSchema,
  agentTurnOutputSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';
import {
  slackChannelIdSchema,
  slackSendMessageConfigSchema,
} from '../../slack/send-message/send-message.schemas.js';
import {
  MODEL_AUTH_TYPE,
  MODEL_PROVIDER_KEY,
} from '../connections.definition.js';

export const agentTurnInputSchema = agentMappedInputSchema.extend({
  toolSchema: boundedNodeJsonRecordSchema,
  history: z
    .array(z.strictObject({ call: agentToolCallSchema, result: z.json() }))
    .max(AGENT_TOOL_LIMITS.historyEntries),
});
const registeredAgentConfigSchema = agentConfigSchema.superRefine(
  ({ tool }, context) => {
    if (!('channelId' in tool.config)) return;
    const { channelId, timeoutMillis } = tool.config;
    if (!slackChannelIdSchema.safeParse(channelId).success)
      context.addIssue({
        code: 'custom',
        path: ['tool', 'config', 'channelId'],
        message: 'Choose a Slack channel.',
      });
    if (!slackSendMessageConfigSchema.safeParse({ timeoutMillis }).success)
      context.addIssue({
        code: 'custom',
        path: ['tool', 'config', 'timeoutMillis'],
        message: 'Use a supported Slack request timeout.',
      });
  },
);

const manifest: NodeManifest = Object.freeze({
  definition: AGENT_STEP,
  family: 'action',
  display: {
    name: 'Agent',
    description: 'Use a model with a workspace tool',
    sideEffect:
      'The mapped task and input, tool schemas and bounded tool results enter the model request.',
  },
  configVersion: 1,
  configSchema: generateSchemaDocument(registeredAgentConfigSchema),
  inputSchema: generateSchemaDocument(agentTurnInputSchema),
  outputSchema: generateSchemaDocument(agentTurnOutputSchema),
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [MODEL_AUTH_TYPE],
  connectionRequirements: [MODEL_AUTH_TYPE, AGENT_SLACK_CONNECTION_SLOT],
  optionalConnections: [AGENT_SLACK_CONNECTION_SLOT],
  integration: { providerKey: MODEL_PROVIDER_KEY, operationKey: 'agent' },
  retryClass: 'safe',
  resourceClass: 'io',
  capabilities: ['external_http', 'side_effect_disclosure'],
  executor: AGENT_STEP,
  executorAbi: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  policyReferences: [],
});

export const AGENT_REGISTRATION = Object.freeze({
  manifest,
  configSchema: registeredAgentConfigSchema,
  inputSchema: agentTurnInputSchema,
  outputSchema: agentTurnOutputSchema,
});
