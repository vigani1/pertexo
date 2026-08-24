import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import { CORE_PARALLEL_BRANCH_PORTS } from '../parallel/validation.js';
import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_MERGE_CONFIG_SCHEMA,
  CORE_MERGE_INPUT_SCHEMA,
  CORE_MERGE_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_MERGE_DEFINITION = Object.freeze({
  key: 'core.merge',
  version: 1,
});
export const CORE_MERGE_EXECUTOR = Object.freeze({
  key: 'core.merge',
  version: 1,
});

export const CORE_MERGE_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_MERGE_DEFINITION,
  family: 'logic',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_MERGE_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_MERGE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_MERGE_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: CORE_PARALLEL_BRANCH_PORTS,
    outputs: ['out'],
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([]),
  lifecycle: 'active',
  executor: CORE_MERGE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
