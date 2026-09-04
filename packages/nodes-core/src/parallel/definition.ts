import {
  generateSchemaDocument,
  type NodeManifest,
  type NodeManifestV2,
} from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_PARALLEL_BRANCH_PORTS,
  CORE_PARALLEL_CONFIG_SCHEMA,
  CORE_PARALLEL_INPUT_SCHEMA,
  CORE_PARALLEL_OUTPUT_SCHEMA,
  CORE_PARALLEL_OUTPUT_SCHEMA_V2,
} from './validation.js';

export const CORE_PARALLEL_DEFINITION = Object.freeze({
  key: 'core.parallel',
  version: 1,
});
export const CORE_PARALLEL_EXECUTOR = Object.freeze({
  key: 'core.parallel',
  version: 1,
});

export const CORE_PARALLEL_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_PARALLEL_DEFINITION,
  family: 'logic',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_PARALLEL_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_PARALLEL_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_PARALLEL_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: CORE_PARALLEL_BRANCH_PORTS,
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([]),
  lifecycle: 'active',
  executor: CORE_PARALLEL_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});

export const CORE_PARALLEL_DEFINITION_V2 = Object.freeze({
  key: 'core.parallel',
  version: 2,
});
export const CORE_PARALLEL_EXECUTOR_V2 = Object.freeze({
  key: 'core.parallel',
  version: 2,
});
export const CORE_PARALLEL_MANIFEST_V2: NodeManifestV2 = Object.freeze({
  ...CORE_PARALLEL_MANIFEST,
  schemaVersion: 2,
  definition: CORE_PARALLEL_DEFINITION_V2,
  configVersion: 2,
  outputSchema: generateSchemaDocument(CORE_PARALLEL_OUTPUT_SCHEMA_V2),
  executor: CORE_PARALLEL_EXECUTOR_V2,
  executorAbi: 1,
});
