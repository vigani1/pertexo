import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_JSONATA_POLICY,
} from '../../../policies.js';
import { COLLECTION_SEMANTICS } from '../semantics/validation.js';
import {
  CORE_FILTER_CONFIG_SCHEMA,
  CORE_FILTER_INPUT_SCHEMA,
  CORE_FILTER_OUTPUT_SCHEMA,
} from './validation.js';
export const CORE_FILTER_DEFINITION = Object.freeze({
  key: 'core.filter',
  version: 1,
});
export const CORE_FILTER_EXECUTOR = Object.freeze({
  key: 'core.filter',
  version: 1,
});
const semantics = Object.freeze([
  ...COLLECTION_SEMANTICS,
  'Equality is strict scalar equality; numeric comparisons require numbers and contains requires strings. No coercion or regular expressions.',
  'Missing fields never match comparisons; exists includes null and not_exists selects only missing paths. Kept items retain original order.',
] as const);
export const CORE_FILTER_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_FILTER_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_FILTER_CONFIG_SCHEMA, {
    runtimeOnlySemantics: semantics,
  }),
  inputSchema: generateSchemaDocument(CORE_FILTER_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_FILTER_OUTPUT_SCHEMA, {
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
  executor: CORE_FILTER_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
