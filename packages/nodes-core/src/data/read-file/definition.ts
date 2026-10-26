import {
  ARTIFACT_INPUT_CAPABILITY,
  generateSchemaDocument,
  type NodeManifest,
} from '@pertexo/node-sdk';
import { CORE_BOUNDED_JSON_POLICY } from '../../policies.js';
import {
  CORE_READ_FILE_CONFIG_SCHEMA,
  CORE_READ_FILE_INPUT_SCHEMA,
  CORE_READ_FILE_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_READ_FILE_DEFINITION = Object.freeze({
  key: 'core.read_file',
  version: 1,
});
export const CORE_READ_FILE_EXECUTOR = Object.freeze({
  ...CORE_READ_FILE_DEFINITION,
});
export const CORE_READ_FILE_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_READ_FILE_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_READ_FILE_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_READ_FILE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_READ_FILE_OUTPUT_SCHEMA, {
    runtimeOnlySemantics: [
      'Inline reads accept up to 1 MiB; explicit Output pages accepts up to 10 MiB through verified disk scratch. Parse the selected format without MIME guessing: JSON and CSV as strict UTF-8 with one optional BOM, Excel as one .xlsx sheet.',
      'Headers are unique, nonblank and untrimmed. CSV uses strict quoting and column counts. Excel reads a header row, cached formula values and ISO dates within entry, size, sheet and cell limits. Conversion defaults on; false keeps text.',
      'Inline mode returns the parsed value with ordinary collection/value limits. Output pages returns ordinary file references, itemCount and pageCount; it never loads all records into a mapped value.',
    ],
  }),
  outputVariant: Object.freeze({
    configProperty: 'outputMode',
    whenPresent: 1,
    whenAbsent: 0,
  }),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'io',
  capabilities: Object.freeze([ARTIFACT_INPUT_CAPABILITY, 'artifact_output']),
  executor: CORE_READ_FILE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
