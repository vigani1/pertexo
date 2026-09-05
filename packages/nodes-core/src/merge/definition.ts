import {
  generateSchemaDocument,
  type NodeManifest,
  type NodeManifestV2,
} from '@pertexo/node-sdk';

import { CORE_PARALLEL_BRANCH_PORTS } from '../parallel/validation.js';
import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_MERGE_CONFIG_SCHEMA,
  CORE_MERGE_INPUT_SCHEMA,
  CORE_MERGE_INPUT_SCHEMA_V2,
  CORE_MERGE_OUTPUT_SCHEMA,
  CORE_MERGE_OUTPUT_SCHEMA_V2,
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
    outputs: Object.freeze(['out']),
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

export const CORE_MERGE_DEFINITION_V2 = Object.freeze({
  key: 'core.merge',
  version: 2,
});
export const CORE_MERGE_EXECUTOR_V2 = Object.freeze({
  key: 'core.merge',
  version: 2,
});
export const CORE_MERGE_MANIFEST_V2: NodeManifestV2 = Object.freeze({
  ...CORE_MERGE_MANIFEST,
  schemaVersion: 2,
  definition: CORE_MERGE_DEFINITION_V2,
  configVersion: 2,
  inputSchema: generateSchemaDocument(CORE_MERGE_INPUT_SCHEMA_V2),
  outputSchema: generateSchemaDocument(CORE_MERGE_OUTPUT_SCHEMA_V2),
  executor: CORE_MERGE_EXECUTOR_V2,
  executorAbi: 1,
});
