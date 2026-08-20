import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_MANUAL_CONFIG_SCHEMA,
  CORE_MANUAL_INPUT_SCHEMA,
  CORE_MANUAL_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_MANUAL_DEFINITION = Object.freeze({
  key: 'core.manual',
  version: 1,
});
export const CORE_MANUAL_EXECUTOR = Object.freeze({
  key: 'core.manual',
  version: 1,
});

export const CORE_MANUAL_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_MANUAL_DEFINITION,
  family: 'trigger',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_MANUAL_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_MANUAL_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_MANUAL_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze([]),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze(['manual']),
  lifecycle: 'active',
  executor: CORE_MANUAL_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
