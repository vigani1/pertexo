import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_WEBHOOK_CONFIG_SCHEMA,
  CORE_WEBHOOK_INPUT_SCHEMA,
  CORE_WEBHOOK_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_WEBHOOK_DEFINITION = Object.freeze({
  key: 'core.webhook',
  version: 1,
});
export const CORE_WEBHOOK_EXECUTOR = Object.freeze({
  key: 'core.webhook',
  version: 1,
});
export const CORE_WEBHOOK_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_WEBHOOK_DEFINITION,
  family: 'trigger',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_WEBHOOK_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_WEBHOOK_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_WEBHOOK_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze([]),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze(['webhook']),
  lifecycle: 'active',
  executor: CORE_WEBHOOK_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
