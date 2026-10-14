import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from '../policies.js';
import { COLLECTION_SEMANTICS } from '../collections/validation.js';
import {
  CORE_TAKE_CONFIG_SCHEMA,
  CORE_TAKE_INPUT_SCHEMA,
  CORE_TAKE_OUTPUT_SCHEMA,
} from './validation.js';
export const CORE_TAKE_DEFINITION = Object.freeze({
  key: 'core.take',
  version: 1,
});
export const CORE_TAKE_EXECUTOR = Object.freeze({
  key: 'core.take',
  version: 1,
});
const semantics = Object.freeze([
  ...COLLECTION_SEMANTICS,
  'Keep the first count items in original order; never mutate the input.',
] as const);
export const CORE_TAKE_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_TAKE_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_TAKE_CONFIG_SCHEMA, {
    runtimeOnlySemantics: semantics,
  }),
  inputSchema: generateSchemaDocument(CORE_TAKE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_TAKE_OUTPUT_SCHEMA, {
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
  executor: CORE_TAKE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
