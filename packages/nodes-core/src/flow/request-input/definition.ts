import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { TIMED_OUT_PORT } from '@pertexo/workflow-model';
import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_JSONATA_POLICY,
} from '../../policies.js';
import {
  CORE_REQUEST_INPUT_CONFIG_SCHEMA,
  CORE_REQUEST_INPUT_INPUT_SCHEMA,
  CORE_REQUEST_INPUT_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_REQUEST_INPUT_DEFINITION = Object.freeze({
  key: 'core.request_input',
  version: 1,
});
export const CORE_REQUEST_INPUT_EXECUTOR = Object.freeze({
  key: 'core.request_input',
  version: 1,
});
export const CORE_REQUEST_INPUT_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_REQUEST_INPUT_DEFINITION,
  family: 'logic',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_REQUEST_INPUT_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_REQUEST_INPUT_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_REQUEST_INPUT_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out', TIMED_OUT_PORT]),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze(['suspends_run']),
  executor: CORE_REQUEST_INPUT_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
