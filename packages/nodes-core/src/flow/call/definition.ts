import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_JSONATA_POLICY,
} from '../../policies.js';
import {
  CORE_CALL_CONFIG_SCHEMA,
  CORE_CALL_INPUT_SCHEMA,
  CORE_CALL_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_CALL_DEFINITION = Object.freeze({
  key: 'core.call',
  version: 1,
});
export const CORE_CALL_EXECUTOR = Object.freeze({
  key: 'core.call',
  version: 1,
});
export const CORE_CALL_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_CALL_DEFINITION,
  family: 'logic',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_CALL_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_CALL_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_CALL_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([]),
  executor: CORE_CALL_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
