import { generateSchemaDocument, type NodeManifestV2 } from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_VALIDATE_CONFIG_SCHEMA,
  CORE_VALIDATE_INPUT_SCHEMA,
  CORE_VALIDATE_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_VALIDATE_DEFINITION = Object.freeze({
  key: 'core.validate',
  version: 1,
});
export const CORE_VALIDATE_EXECUTOR = Object.freeze({
  key: 'core.validate',
  version: 1,
});

const CORE_VALIDATE_RUNTIME_SEMANTICS = Object.freeze([
  'Validate rule paths use the browser-safe platform JSON path parser with own-property resolution and no wildcards or recursive descent.',
  'Validate rule IDs and enum scalar values are unique; enum has at most 32 values and enum strings are at most 256 UTF-8 bytes.',
  'Validate constraint fields require their declared value type, and each lower bound must be at most its matching upper bound.',
  'Validate paths are bounded to 512 UTF-8 bytes and 64 segments, and evaluation emits at most 16 fixed issues.',
  'Validate issue codes require their exact fixed versioned messages, with at most one issue per rule and no observed input values.',
  'Validate output valid is false when issues exist or evaluation is truncated; truncation requires exactly 16 issues and means remaining rules were not evaluated.',
  'Validate mismatch is a successful typed result; the output never echoes the observed input value.',
] as const);

export const CORE_VALIDATE_MANIFEST: NodeManifestV2 = Object.freeze({
  schemaVersion: 2,
  definition: CORE_VALIDATE_DEFINITION,
  family: 'transform',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_VALIDATE_CONFIG_SCHEMA, {
    runtimeOnlySemantics: CORE_VALIDATE_RUNTIME_SEMANTICS,
  }),
  inputSchema: generateSchemaDocument(CORE_VALIDATE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_VALIDATE_OUTPUT_SCHEMA, {
    runtimeOnlySemantics: CORE_VALIDATE_RUNTIME_SEMANTICS,
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
  lifecycle: 'active',
  executor: CORE_VALIDATE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
