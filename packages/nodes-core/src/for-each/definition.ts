import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_FOR_EACH_CONFIG_SCHEMA,
  CORE_FOR_EACH_INPUT_SCHEMA,
  CORE_FOR_EACH_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_FOR_EACH_DEFINITION = Object.freeze({
  key: 'core.foreach',
  version: 1,
});
export const CORE_FOR_EACH_EXECUTOR = Object.freeze({
  key: 'core.foreach',
  version: 1,
});

export const CORE_FOR_EACH_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_FOR_EACH_DEFINITION,
  family: 'logic',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_FOR_EACH_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_FOR_EACH_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_FOR_EACH_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([]),
  lifecycle: 'active',
  executor: CORE_FOR_EACH_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
