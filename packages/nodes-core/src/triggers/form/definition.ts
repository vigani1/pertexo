import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY } from '../../policies.js';
import {
  CORE_FORM_CONFIG_SCHEMA,
  CORE_FORM_INPUT_SCHEMA,
  CORE_FORM_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_FORM_DEFINITION = Object.freeze({
  key: 'core.form',
  version: 1,
});
export const CORE_FORM_EXECUTOR = Object.freeze({
  key: 'core.form',
  version: 1,
});
export const CORE_FORM_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_FORM_DEFINITION,
  family: 'trigger',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_FORM_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_FORM_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_FORM_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze([]),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([]),
  executor: CORE_FORM_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
