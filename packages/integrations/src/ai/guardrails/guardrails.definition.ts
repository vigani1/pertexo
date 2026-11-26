import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { GUARDRAILS_PORTS, GUARDRAILS_STEP } from '@pertexo/workflow-model';
import { DISPATCH_AWARE_EXECUTOR_ABI_VERSION } from '@pertexo/node-sdk/server';
import {
  MODEL_AUTH_TYPE,
  MODEL_PROVIDER_KEY,
} from '../connections.definition.js';
import {
  type GuardrailsConfig,
  guardrailsConfigSchema,
  guardrailsInputSchema,
  guardrailsOutputSchema,
} from './guardrails.schemas.js';

const manifest: NodeManifest = Object.freeze({
  definition: GUARDRAILS_STEP,
  family: 'action',
  display: {
    name: 'Guardrails',
    description:
      'Check text for sensitive information, prohibited terms or prompt injection, with optional model review',
  },
  configVersion: 1,
  configSchema: generateSchemaDocument(guardrailsConfigSchema),
  inputSchema: generateSchemaDocument(guardrailsInputSchema),
  outputSchema: generateSchemaDocument(guardrailsOutputSchema),
  ports: { inputs: ['in'], outputs: GUARDRAILS_PORTS },
  credentialRequirements: [],
  connectionRequirements: [MODEL_AUTH_TYPE],
  optionalConnections: [MODEL_AUTH_TYPE],
  integration: { providerKey: MODEL_PROVIDER_KEY, operationKey: 'guardrails' },
  retryClass: 'safe',
  resourceClass: 'io',
  capabilities: ['external_http', 'side_effect_disclosure'],
  executor: GUARDRAILS_STEP,
  executorAbi: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  policyReferences: [],
});

export const GUARDRAILS_REGISTRATION = Object.freeze({
  manifest,
  assistantDisclosure: {
    config: { visible: ['checks'] },
    inputs: { visible: ['text'] },
  } as const,
  configSchema: guardrailsConfigSchema,
  requiredConnectionsForConfig: (config: unknown) =>
    (config as GuardrailsConfig).checks.some(({ kind }) => kind === 'model')
      ? [MODEL_AUTH_TYPE]
      : [],
  inputSchema: guardrailsInputSchema,
  outputSchema: guardrailsOutputSchema,
});
