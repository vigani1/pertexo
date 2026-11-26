import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { DISPATCH_AWARE_EXECUTOR_ABI_VERSION } from '@pertexo/node-sdk/server';
import {
  CLASSIFY_STEP,
  CLASSIFY_CATEGORY_PORTS,
  CLASSIFY_OTHER_PORT,
  classifyCategoriesSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';
import {
  MODEL_AUTH_TYPE,
  MODEL_PROVIDER_KEY,
} from '../connections.definition.js';
import { modelSettings } from '../model-settings.js';

const configSchema = z.strictObject({
  ...modelSettings,
  categories: classifyCategoriesSchema,
});
const inputSchema = z.strictObject({
  text: z.string().min(1).meta({ title: 'Text' }),
});
const outputSchema = z.strictObject({
  selectedPort: z.enum([...CLASSIFY_CATEGORY_PORTS, CLASSIFY_OTHER_PORT]),
});

const manifest: NodeManifest = Object.freeze({
  definition: CLASSIFY_STEP,
  family: 'action',
  display: {
    name: 'Classify',
    description: 'Route text to one category with a model',
    sideEffect:
      'This sends the mapped text and category definitions to the model provider. Inference can incur charges.',
  },
  configVersion: 1,
  configSchema: generateSchemaDocument(configSchema),
  inputSchema: generateSchemaDocument(inputSchema),
  outputSchema: generateSchemaDocument(outputSchema),
  ports: {
    inputs: ['in'],
    outputs: [...CLASSIFY_CATEGORY_PORTS, CLASSIFY_OTHER_PORT],
  },
  credentialRequirements: [MODEL_AUTH_TYPE],
  connectionRequirements: [MODEL_AUTH_TYPE],
  integration: { providerKey: MODEL_PROVIDER_KEY, operationKey: 'classify' },
  retryClass: 'safe',
  resourceClass: 'io',
  capabilities: ['external_http', 'side_effect_disclosure'],
  executor: CLASSIFY_STEP,
  executorAbi: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  policyReferences: [],
});

export const CLASSIFY_REGISTRATION = Object.freeze({
  manifest,
  assistantDisclosure: {
    config: {
      visible: ['model', 'timeoutMillis', 'maxOutputTokens', 'categories'],
    },
    inputs: { visible: ['text'] },
  } as const,
  configSchema,
  inputSchema,
  outputSchema,
});
