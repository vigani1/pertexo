import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_WORKFLOW_CALL_CONFIG_SCHEMA,
  CORE_WORKFLOW_CALL_INPUT_SCHEMA,
  CORE_WORKFLOW_CALL_OUTPUT_SCHEMA,
} from './validation.js';

export const CORE_WORKFLOW_CALL_DEFINITION = Object.freeze({
  key: 'core.workflow_call',
  version: 1,
});
export const CORE_WORKFLOW_CALL_EXECUTOR = Object.freeze({
  key: 'core.workflow_call',
  version: 1,
});
export const CORE_WORKFLOW_CALL_POLICY = Object.freeze({
  key: 'workflow.call',
  version: 1,
});

export const CORE_WORKFLOW_CALL_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_WORKFLOW_CALL_DEFINITION,
  family: 'logic',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_WORKFLOW_CALL_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_WORKFLOW_CALL_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_WORKFLOW_CALL_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  // Conservative effect classification, not a no-retry guarantee. The pinned
  // workflow.call control policy forbids automatic logical-call retries.
  retryClass: 'unsafe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([]),
  lifecycle: 'active',
  executor: CORE_WORKFLOW_CALL_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_WORKFLOW_CALL_POLICY,
  ]),
});
