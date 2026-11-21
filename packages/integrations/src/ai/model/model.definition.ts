import { DISPATCH_AWARE_EXECUTOR_ABI_VERSION } from '@pertexo/node-sdk/server';
import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import {
  MODEL_AUTH_TYPE,
  MODEL_PROVIDER_KEY,
} from '../connections.definition.js';
import {
  modelConfigSchema,
  modelInputSchema,
  modelOutputSchema,
} from './model.schemas.js';

export const MODEL_STEP = Object.freeze({ key: 'ai.model', version: 1 });

const manifest: NodeManifest = Object.freeze({
  definition: MODEL_STEP,
  family: 'action',
  display: {
    name: 'AI Model',
    description: 'Generate text or extract structured data with a model',
    sideEffect:
      'This sends the mapped prompt to the model provider. Inference can incur charges.',
  },
  configVersion: 1,
  configSchema: generateSchemaDocument(modelConfigSchema, {
    runtimeOnlySemantics: [
      'The structured output schema must use the supported bounded JSON Schema subset.',
    ],
  }),
  inputSchema: generateSchemaDocument(modelInputSchema),
  outputSchema: generateSchemaDocument(modelOutputSchema),
  outputVariant: {
    configProperty: 'outputSchema',
    whenPresent: 1,
    whenAbsent: 0,
  },
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [MODEL_AUTH_TYPE],
  connectionRequirements: [MODEL_AUTH_TYPE],
  integration: { providerKey: MODEL_PROVIDER_KEY, operationKey: 'model' },
  retryClass: 'safe',
  resourceClass: 'io',
  capabilities: ['external_http', 'side_effect_disclosure'],
  executor: MODEL_STEP,
  executorAbi: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  policyReferences: [],
});

export const MODEL_REGISTRATION = Object.freeze({
  manifest,
  configSchema: modelConfigSchema,
  inputSchema: modelInputSchema,
  outputSchema: modelOutputSchema,
});
