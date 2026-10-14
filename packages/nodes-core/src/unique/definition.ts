import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from '../policies.js';
import { COLLECTION_SEMANTICS } from '../collections/validation.js';
import {
  CORE_UNIQUE_CONFIG_SCHEMA,
  CORE_UNIQUE_INPUT_SCHEMA,
  CORE_UNIQUE_OUTPUT_SCHEMA,
} from './validation.js';
export const CORE_UNIQUE_DEFINITION = Object.freeze({
  key: 'core.unique',
  version: 1,
});
export const CORE_UNIQUE_EXECUTOR = Object.freeze({
  key: 'core.unique',
  version: 1,
});
const semantics = Object.freeze([
  ...COLLECTION_SEMANTICS,
  'Canonical JSON equality ignores object key order but preserves array order and scalar types. Keep the first item in original order.',
  'Missing keys fail or are explicitly skipped. Null is a real key; duplicate and missing-key counts remain separate. No cross-run state.',
] as const);
export const CORE_UNIQUE_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_UNIQUE_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_UNIQUE_CONFIG_SCHEMA, {
    runtimeOnlySemantics: semantics,
  }),
  inputSchema: generateSchemaDocument(CORE_UNIQUE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_UNIQUE_OUTPUT_SCHEMA, {
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
  executor: CORE_UNIQUE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
