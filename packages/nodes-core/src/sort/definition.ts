import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from '../policies.js';
import { COLLECTION_SEMANTICS } from '../collections/validation.js';
import {
  CORE_SORT_CONFIG_SCHEMA,
  CORE_SORT_INPUT_SCHEMA,
  CORE_SORT_OUTPUT_SCHEMA,
} from './validation.js';
export const CORE_SORT_DEFINITION = Object.freeze({
  key: 'core.sort',
  version: 1,
});
export const CORE_SORT_EXECUTOR = Object.freeze({
  key: 'core.sort',
  version: 1,
});
const semantics = Object.freeze([
  ...COLLECTION_SEMANTICS,
  'Sort is stable. Numeric keys compare numerically and text keys by UTF-16 code-unit order; present non-null keys must match the declared type.',
  'Missing and null keys keep their original relative order in the chosen first/last bucket, independent of ascending/descending direction.',
] as const);
export const CORE_SORT_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_SORT_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_SORT_CONFIG_SCHEMA, {
    runtimeOnlySemantics: semantics,
  }),
  inputSchema: generateSchemaDocument(CORE_SORT_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_SORT_OUTPUT_SCHEMA, {
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
  executor: CORE_SORT_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
