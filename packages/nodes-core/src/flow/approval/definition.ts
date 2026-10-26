import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { TIMED_OUT_PORT } from '@pertexo/workflow-model';
import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_JSONATA_POLICY,
} from '../../policies.js';
import {
  CORE_APPROVAL_CONFIG_SCHEMA,
  CORE_APPROVAL_INPUT_SCHEMA,
  CORE_APPROVAL_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_APPROVAL_DEFINITION = Object.freeze({
  key: 'core.approval',
  version: 1,
});
export const CORE_APPROVAL_EXECUTOR = Object.freeze({
  key: 'core.approval',
  version: 1,
});
export const CORE_APPROVAL_MANIFEST: NodeManifest = Object.freeze({
  definition: CORE_APPROVAL_DEFINITION,
  family: 'logic',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_APPROVAL_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_APPROVAL_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_APPROVAL_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['approved', 'rejected', TIMED_OUT_PORT]),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze(['suspends_run']),
  executor: CORE_APPROVAL_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
});
