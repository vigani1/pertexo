import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from '../policies.js';
import {
  CORE_SWITCH_CASE_PORTS,
  CORE_SWITCH_CONFIG_SCHEMA,
  CORE_SWITCH_INPUT_SCHEMA,
  CORE_SWITCH_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_SWITCH_DEFINITION = Object.freeze({
  key: 'core.switch',
  version: 1,
});
export const CORE_SWITCH_EXECUTOR = Object.freeze({
  key: 'core.switch',
  version: 1,
});

export const CORE_SWITCH_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_SWITCH_DEFINITION,
  family: 'logic',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_SWITCH_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_SWITCH_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_SWITCH_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze([...CORE_SWITCH_CASE_PORTS, 'default']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([]),
  lifecycle: 'active',
  executor: CORE_SWITCH_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
