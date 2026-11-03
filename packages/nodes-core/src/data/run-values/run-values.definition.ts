import {
  generateSchemaDocument,
  saveRunValuesInputSchema,
  saveRunValuesOutputSchema,
  type NodeManifest,
} from '@pertexo/node-sdk';
import { z } from 'zod';
import { CORE_BOUNDED_JSON_POLICY } from '../../policies.js';
export const CORE_RUN_VALUES_DEFINITION = Object.freeze({
  key: 'core.run_values',
  version: 1,
});
export const CORE_RUN_VALUES_CONFIG_SCHEMA = z.object({}).strict();
export const CORE_RUN_VALUES_INPUT_SCHEMA = saveRunValuesInputSchema;
export const CORE_RUN_VALUES_OUTPUT_SCHEMA = saveRunValuesOutputSchema;
export const CORE_RUN_VALUES_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_RUN_VALUES_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_RUN_VALUES_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_RUN_VALUES_INPUT_SCHEMA, {
    runtimeOnlySemantics: [
      'Save one to ten text key/value pairs. Keys use up to 50 ASCII characters; values use up to 255 characters. These values are visible with the run: use business data, never secrets.',
    ],
  }),
  outputSchema: generateSchemaDocument(CORE_RUN_VALUES_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'io',
  capabilities: Object.freeze(['run_values']),
  executor: CORE_RUN_VALUES_DEFINITION,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
