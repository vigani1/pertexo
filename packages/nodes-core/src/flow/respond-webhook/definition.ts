import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { CORE_BOUNDED_JSON_POLICY } from '../../policies.js';
import {
  CORE_RESPOND_WEBHOOK_CONFIG_SCHEMA,
  CORE_RESPOND_WEBHOOK_INPUT_SCHEMA,
  CORE_RESPOND_WEBHOOK_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_RESPOND_WEBHOOK_DEFINITION = Object.freeze({
  key: 'core.respond_webhook',
  version: 1,
});
export const CORE_RESPOND_WEBHOOK_EXECUTOR = Object.freeze({
  ...CORE_RESPOND_WEBHOOK_DEFINITION,
});
export const CORE_RESPOND_WEBHOOK_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_RESPOND_WEBHOOK_DEFINITION,
  family: 'output',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_RESPOND_WEBHOOK_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_RESPOND_WEBHOOK_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_RESPOND_WEBHOOK_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'io',
  capabilities: Object.freeze(['webhook_response']),
  executor: CORE_RESPOND_WEBHOOK_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});
