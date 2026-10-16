import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { CORE_BOUNDED_JSON_POLICY } from '../../policies.js';
import {
  CORE_CODE_CONFIG_SCHEMA,
  CORE_CODE_INPUT_SCHEMA,
  CORE_CODE_OUTPUT_SCHEMA,
} from './validation.js';
export const CORE_CODE_DEFINITION = Object.freeze({
  key: 'core.code',
  version: 1,
});
export const CORE_CODE_EXECUTOR = Object.freeze({ ...CORE_CODE_DEFINITION });
export const CORE_CODE_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_CODE_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_CODE_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_CODE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_CODE_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze(['code_runner']),
  executor: CORE_CODE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
