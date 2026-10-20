import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { CORE_BOUNDED_JSON_POLICY } from '../../policies.js';
import {
  CORE_CREATE_FILE_CONFIG_SCHEMA,
  CORE_CREATE_FILE_INPUT_SCHEMA,
  CORE_CREATE_FILE_OUTPUT_SCHEMA,
} from './validation.js';
export const CORE_CREATE_FILE_DEFINITION = Object.freeze({
  key: 'core.create_file',
  version: 1,
});
export const CORE_CREATE_FILE_EXECUTOR = Object.freeze({
  ...CORE_CREATE_FILE_DEFINITION,
});
export const CORE_CREATE_FILE_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_CREATE_FILE_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_CREATE_FILE_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_CREATE_FILE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_CREATE_FILE_OUTPUT_SCHEMA, {
    runtimeOnlySemantics: [
      'Create a UTF-8 CSV, JSON or text file up to 1 MiB, including headers and quoting. Split larger data into smaller files.',
      'CSV accepts bounded object rows, always writes a header, preserves explicit column order, and protects spreadsheet formulas. An empty column list discovers fields in first-seen order.',
      'Files use existing workspace-scoped artifact storage, accounting and run/preview retention. No external destination is called.',
    ],
  }),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'io',
  capabilities: Object.freeze(['artifact_output']),
  executor: CORE_CREATE_FILE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
