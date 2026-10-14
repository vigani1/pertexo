import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_JSONATA_POLICY,
} from '../../../policies.js';
import { COLLECTION_SEMANTICS } from '../semantics/validation.js';
import {
  CORE_SUMMARIZE_CONFIG_SCHEMA,
  CORE_SUMMARIZE_INPUT_SCHEMA,
  CORE_SUMMARIZE_OUTPUT_SCHEMA,
} from './validation.js';
export const CORE_SUMMARIZE_DEFINITION = Object.freeze({
  key: 'core.summarize',
  version: 1,
});
export const CORE_SUMMARIZE_EXECUTOR = Object.freeze({
  key: 'core.summarize',
  version: 1,
});
const semantics = Object.freeze([
  ...COLLECTION_SEMANTICS,
  'Finite IEEE-754 numeric aggregation uses input order; unsafe integer operands/intermediate results and non-finite arithmetic fail without rounding.',
  'Groups have scalar keys and first-seen order. Missing/null numbers or absent group keys fail or skip; wrong types always fail.',
  'Empty ungrouped input produces one null-key zero-count/sum group with null min/max/average. Empty grouped input produces no groups.',
] as const);
export const CORE_SUMMARIZE_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_SUMMARIZE_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_SUMMARIZE_CONFIG_SCHEMA, {
    runtimeOnlySemantics: semantics,
  }),
  inputSchema: generateSchemaDocument(CORE_SUMMARIZE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_SUMMARIZE_OUTPUT_SCHEMA, {
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
  executor: CORE_SUMMARIZE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
