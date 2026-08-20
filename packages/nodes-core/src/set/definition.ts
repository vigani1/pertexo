import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from '../policies.js';
import {
  CORE_SET_CONFIG_SCHEMA,
  CORE_SET_INPUT_SCHEMA,
  CORE_SET_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_SET_DEFINITION = Object.freeze({
  key: 'core.set',
  version: 1,
});
export const CORE_SET_EXECUTOR = Object.freeze({ key: 'core.set', version: 1 });

export const CORE_SET_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_SET_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_SET_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_SET_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_SET_OUTPUT_SCHEMA),
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
  executor: CORE_SET_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
