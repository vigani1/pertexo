import {
  boundedNodeJsonRecordSchema,
  generateSchemaDocument,
  type NodeManifest,
} from '@pertexo/node-sdk';
import { DISPATCH_AWARE_EXECUTOR_ABI_VERSION } from '@pertexo/node-sdk/server';
import {
  AGENT_STEP,
  AGENT_STEP_V2,
  AGENT_STEP_V3,
  AGENT_SLACK_CONNECTION_SLOT,
  AGENT_TOOL_LIMITS,
  agentMappedInputSchema,
  agentConfigV1Schema,
  agentConfigV2Schema,
  agentConfigV3Schema,
  agentToolCallSchema,
  agentTurnOutputSchema,
  type AgentToolConfig,
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
function agentRegistration(
  definition: typeof AGENT_STEP | typeof AGENT_STEP_V2,
  schema: typeof agentConfigV1Schema | typeof agentConfigV2Schema,
) {
  const configSchema = schema.superRefine(({ tool }, context) => {
    checkSlackToolSetup(tool.config, ['tool', 'config'], context);
  });

  const manifest: NodeManifest = Object.freeze({
    definition,
    family: 'action',
    display: {
      name: 'Agent',
      description: 'Use a model with a workspace tool',
      sideEffect:
        'The mapped task and input, tool schemas and bounded tool results enter the model request.',
    },
    configVersion: 1,
    configSchema: generateSchemaDocument(configSchema),
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
    executor: definition,
    executorAbi: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
    policyReferences: [],
  });

  return Object.freeze({
    manifest,
    configSchema,
    inputSchema: agentTurnInputSchema,
    outputSchema: agentTurnOutputSchema,
  });
}

export const multiToolAgentTurnInputSchema = agentTurnInputSchema
  .omit({ toolSchema: true })
  .extend({
    tools: z
      .array(
        z.strictObject({
          name: z.string(),
          description: z.string(),
          inputSchema: boundedNodeJsonRecordSchema,
        }),
      )
      .min(1)
      .max(AGENT_TOOL_LIMITS.tools),
  });

const legacyAgent = agentRegistration(AGENT_STEP, agentConfigV1Schema);
const idBoundAgent = agentRegistration(AGENT_STEP_V2, agentConfigV2Schema);
const multiToolConfig = agentConfigV3Schema.superRefine(
  ({ tools }, context) => {
    for (const [index, { config }] of tools.entries())
      checkSlackToolSetup(config, ['tools', index, 'config'], context);
  },
);

function checkSlackToolSetup(
  config: AgentToolConfig['config'],
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  if (!('channelId' in config)) return;
  if (!slackChannelIdSchema.safeParse(config.channelId).success)
    context.addIssue({
      code: 'custom',
      path: [...path, 'channelId'],
      message: 'Choose a Slack channel.',
    });
  if (
    !slackSendMessageConfigSchema.safeParse({
      timeoutMillis: config.timeoutMillis,
    }).success
  )
    context.addIssue({
      code: 'custom',
      path: [...path, 'timeoutMillis'],
      message: 'Use a supported Slack request timeout.',
    });
}

export const AGENT_REGISTRATIONS = [
  legacyAgent,
  idBoundAgent,
  {
    ...idBoundAgent,
    configSchema: multiToolConfig,
    inputSchema: multiToolAgentTurnInputSchema,
    manifest: Object.freeze({
      ...idBoundAgent.manifest,
      definition: AGENT_STEP_V3,
      executor: AGENT_STEP_V3,
      configSchema: generateSchemaDocument(multiToolConfig),
      inputSchema: generateSchemaDocument(multiToolAgentTurnInputSchema),
      display: {
        ...idBoundAgent.manifest.display,
        name: 'Agent',
        description: 'Use a model with workspace tools',
      },
    }) satisfies NodeManifest,
  },
];
