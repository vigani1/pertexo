import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { GUARDRAILS_PORTS, GUARDRAILS_STEP } from '@pertexo/workflow-model';
import { MODEL_PROVIDER_KEY } from '../connections.definition.js';
import {
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
      'Check text for sensitive information, prohibited terms or injection markers',
  },
  configVersion: 1,
  configSchema: generateSchemaDocument(guardrailsConfigSchema),
  inputSchema: generateSchemaDocument(guardrailsInputSchema),
  outputSchema: generateSchemaDocument(guardrailsOutputSchema),
  ports: { inputs: ['in'], outputs: GUARDRAILS_PORTS },
  credentialRequirements: [],
  connectionRequirements: [],
  integration: { providerKey: MODEL_PROVIDER_KEY, operationKey: 'guardrails' },
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: [],
  executor: GUARDRAILS_STEP,
  executorAbi: 1,
  policyReferences: [],
});

export const GUARDRAILS_REGISTRATION = Object.freeze({
  manifest,
  configSchema: guardrailsConfigSchema,
  inputSchema: guardrailsInputSchema,
  outputSchema: guardrailsOutputSchema,
});
