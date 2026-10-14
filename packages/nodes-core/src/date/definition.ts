import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from '../policies.js';
import {
  CORE_DATE_CONFIG_SCHEMA,
  CORE_DATE_INPUT_SCHEMA,
  CORE_DATE_OUTPUT_SCHEMA,
} from './validation.js';
export const CORE_DATE_DEFINITION = Object.freeze({
  key: 'core.date',
  version: 1,
});
export const CORE_DATE_EXECUTOR = Object.freeze({
  key: 'core.date',
  version: 1,
});
const semantics = Object.freeze([
  'Convert only integer epoch milliseconds or valid four-digit-year calendar timestamps with an explicit numeric offset or Z and at most 3 fractional digits.',
  'UTC instant must stay in years 0000 through 9999; ISO output uses UTC and three fractional digits. Invalid-day rollover, leap seconds and local-time inference are forbidden.',
] as const);
export const CORE_DATE_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_DATE_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_DATE_CONFIG_SCHEMA, {
    runtimeOnlySemantics: semantics,
  }),
  inputSchema: generateSchemaDocument(CORE_DATE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_DATE_OUTPUT_SCHEMA, {
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
  executor: CORE_DATE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
