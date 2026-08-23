import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from '../policies.js';
import {
  CORE_CONDITION_CONFIG_SCHEMA,
  CORE_CONDITION_INPUT_SCHEMA,
  CORE_CONDITION_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_CONDITION_DEFINITION = Object.freeze({
  key: 'core.condition',
  version: 1,
});
export const CORE_CONDITION_EXECUTOR = Object.freeze({
  key: 'core.condition',
  version: 1,
});

export const CORE_CONDITION_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_CONDITION_DEFINITION,
  family: 'logic',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_CONDITION_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_CONDITION_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_CONDITION_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['true', 'false']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([]),
  lifecycle: 'active',
  executor: CORE_CONDITION_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
