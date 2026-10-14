import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from '../policies.js';
import { COLLECTION_SEMANTICS } from '../collections/validation.js';
import {
  CORE_CONCAT_CONFIG_SCHEMA,
  CORE_CONCAT_INPUT_SCHEMA,
  CORE_CONCAT_OUTPUT_SCHEMA,
} from './validation.js';
export const CORE_CONCAT_DEFINITION = Object.freeze({
  key: 'core.concat',
  version: 1,
});
export const CORE_CONCAT_EXECUTOR = Object.freeze({
  key: 'core.concat',
  version: 1,
});
const semantics = Object.freeze([
  ...COLLECTION_SEMANTICS,
  'Append otherItems after items, preserving order and duplicates; reject a combined length above the collection cap.',
] as const);
export const CORE_CONCAT_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_CONCAT_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_CONCAT_CONFIG_SCHEMA, {
    runtimeOnlySemantics: semantics,
  }),
  inputSchema: generateSchemaDocument(CORE_CONCAT_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_CONCAT_OUTPUT_SCHEMA, {
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
  executor: CORE_CONCAT_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
