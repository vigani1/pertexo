import {
  boundedNodeJsonRecordSchema,
  generateSchemaDocument,
  type NodeManifest,
} from '@pertexo/node-sdk';
import { DISPATCH_AWARE_EXECUTOR_ABI_VERSION } from '@pertexo/node-sdk/server';
import {
  AGENT_STEP,
  AGENT_TOOL_LIMITS,
  agentMappedInputSchema,
  agentConfigSchema,
  agentToolCallSchema,
  agentTurnOutputSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';
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

const manifest: NodeManifest = Object.freeze({
  definition: AGENT_STEP,
  family: 'action',
  display: {
    name: 'Agent',
    description: 'Use a model with a workspace read tool',
    sideEffect:
      'The mapped task and input, tool schemas and bounded tool results enter the model request.',
  },
  configVersion: 1,
  configSchema: generateSchemaDocument(agentConfigSchema),
  inputSchema: generateSchemaDocument(agentTurnInputSchema),
  outputSchema: generateSchemaDocument(agentTurnOutputSchema),
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [MODEL_AUTH_TYPE],
  connectionRequirements: [MODEL_AUTH_TYPE],
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
  configSchema: agentConfigSchema,
  inputSchema: agentTurnInputSchema,
  outputSchema: agentTurnOutputSchema,
});
