import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_JSONATA_POLICY,
} from '../../../policies.js';
import { COLLECTION_SEMANTICS } from '../semantics/validation.js';
import {
  CORE_BATCH_CONFIG_SCHEMA,
  CORE_BATCH_INPUT_SCHEMA,
  CORE_BATCH_OUTPUT_SCHEMA,
} from './validation.js';
export const CORE_BATCH_DEFINITION = Object.freeze({
  key: 'core.batch',
  version: 1,
});
export const CORE_BATCH_EXECUTOR = Object.freeze({
  key: 'core.batch',
  version: 1,
});
const semantics = Object.freeze([
  ...COLLECTION_SEMANTICS,
  'Return ordered arrays of at most size items; the last batch may be smaller. No iteration or execution is started.',
] as const);
export const CORE_BATCH_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_BATCH_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_BATCH_CONFIG_SCHEMA, {
    runtimeOnlySemantics: semantics,
  }),
  inputSchema: generateSchemaDocument(CORE_BATCH_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_BATCH_OUTPUT_SCHEMA, {
    runtimeOnlySemantics: semantics,
  }),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([]),
  executor: CORE_BATCH_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
