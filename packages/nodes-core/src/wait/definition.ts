import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_WAIT_CONFIG_SCHEMA,
  CORE_WAIT_INPUT_SCHEMA,
  CORE_WAIT_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_WAIT_DEFINITION = Object.freeze({
  key: 'core.wait',
  version: 1,
});
export const CORE_WAIT_EXECUTOR = Object.freeze({
  key: 'core.wait',
  version: 1,
});
export const CORE_WAIT_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_WAIT_DEFINITION,
  family: 'logic',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_WAIT_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_WAIT_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_WAIT_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze(['suspends_run']),
  lifecycle: 'active',
  executor: CORE_WAIT_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
