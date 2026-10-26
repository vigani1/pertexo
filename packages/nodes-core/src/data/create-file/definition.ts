import {
  ARTIFACT_INPUT_CAPABILITY,
  generateSchemaDocument,
  type NodeManifest,
} from '@pertexo/node-sdk';
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
      'Inline data creates up to 1 MiB. Explicit From pages streams ordered JSON-array files into CSV, Excel or JSON up to 10 MiB, including headers and quoting. CSV and Excel from pages require explicit columns.',
      'CSV and Excel take bounded object rows, always write a header, keep explicit column order and protect formula-like text. Excel writes one sheet with a bold frozen header and typed cells. Empty columns discover fields.',
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
  capabilities: Object.freeze(['artifact_output', ARTIFACT_INPUT_CAPABILITY]),
  executor: CORE_CREATE_FILE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
