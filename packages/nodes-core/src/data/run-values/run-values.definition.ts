import {
  generateSchemaDocument,
  type NodeManifest,
  RUN_VALUE_LIMITS,
} from '@pertexo/node-sdk';
import { CORE_BOUNDED_JSON_POLICY } from '../../catalog/core-policies.js';
import {
  CORE_RUN_VALUES_CONFIG_SCHEMA,
  CORE_RUN_VALUES_INPUT_SCHEMA,
  CORE_RUN_VALUES_OUTPUT_SCHEMA,
} from './run-values.schemas.js';
export const CORE_RUN_VALUES_DEFINITION = Object.freeze({
  key: 'core.run_values',
  version: 1,
});
export const CORE_RUN_VALUES_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_RUN_VALUES_DEFINITION,
  family: 'transform',
  display: Object.freeze({
    name: 'Save run values',
    description: 'Save business values on a run for exact lookup',
  }),
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_RUN_VALUES_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_RUN_VALUES_INPUT_SCHEMA, {
    runtimeOnlySemantics: [
      `Save one to ${String(RUN_VALUE_LIMITS.pairs)} text key/value pairs. Keys use up to ${String(RUN_VALUE_LIMITS.keyCharacters)} ASCII characters; values use up to ${String(RUN_VALUE_LIMITS.valueCharacters)} characters. These values are visible with the run: use business data, never secrets.`,
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
