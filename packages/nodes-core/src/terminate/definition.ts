import {
  generateSchemaDocument,
  TERMINATES_RUN_CAPABILITY,
  type NodeManifest,
} from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_TERMINATE_CONFIG_SCHEMA,
  CORE_TERMINATE_INPUT_SCHEMA,
  CORE_TERMINATE_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_TERMINAL_CAPABILITY = TERMINATES_RUN_CAPABILITY;
export const CORE_TERMINATE_DEFINITION = Object.freeze({
  key: 'core.terminate',
  version: 1,
});
export const CORE_TERMINATE_EXECUTOR = Object.freeze({
  key: 'core.terminate',
  version: 1,
});

export const CORE_TERMINATE_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_TERMINATE_DEFINITION,
  family: 'output',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_TERMINATE_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_TERMINATE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_TERMINATE_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze([]),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([CORE_TERMINAL_CAPABILITY]),
  lifecycle: 'active',
  executor: CORE_TERMINATE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
