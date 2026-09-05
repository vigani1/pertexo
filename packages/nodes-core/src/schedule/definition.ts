import {
  generateSchemaDocument,
  type NodeManifest,
  type NodeManifestV2,
} from '@pertexo/node-sdk';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_SCHEDULE_CONFIG_SCHEMA,
  CORE_SCHEDULE_CONFIG_SCHEMA_V2,
  CORE_SCHEDULE_INPUT_SCHEMA,
  CORE_SCHEDULE_INPUT_SCHEMA_V2,
  CORE_SCHEDULE_OUTPUT_SCHEMA,
  CORE_SCHEDULE_OUTPUT_SCHEMA_V2,
} from './validation.js';

export const CORE_SCHEDULE_DEFINITION = Object.freeze({
  key: 'core.schedule',
  version: 1,
});
export const CORE_SCHEDULE_EXECUTOR = Object.freeze({
  key: 'core.schedule',
  version: 1,
});
export const CORE_SCHEDULE_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: CORE_SCHEDULE_DEFINITION,
  family: 'trigger',
  configVersion: 1,
  configSchema: generateSchemaDocument(CORE_SCHEDULE_CONFIG_SCHEMA),
  inputSchema: generateSchemaDocument(CORE_SCHEDULE_INPUT_SCHEMA),
  outputSchema: generateSchemaDocument(CORE_SCHEDULE_OUTPUT_SCHEMA),
  ports: Object.freeze({
    inputs: Object.freeze([]),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([]),
  connectionRequirements: Object.freeze([]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze(['schedule']),
  lifecycle: 'active',
  executor: CORE_SCHEDULE_EXECUTOR,
  executorAbi: 1,
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
});

export const CORE_SCHEDULE_DEFINITION_V2 = Object.freeze({
  key: 'core.schedule',
  version: 2,
});
export const CORE_SCHEDULE_EXECUTOR_V2 = Object.freeze({
  key: 'core.schedule',
  version: 2,
});
export const CORE_SCHEDULE_DEFINITION_V3 = Object.freeze({
  key: 'core.schedule',
  version: 3,
});
export const CORE_SCHEDULE_EXECUTOR_V3 = Object.freeze({
  key: 'core.schedule',
  version: 3,
});
export const CORE_SCHEDULE_MANIFEST_V2: NodeManifestV2 = Object.freeze({
  ...CORE_SCHEDULE_MANIFEST,
  schemaVersion: 2,
  definition: CORE_SCHEDULE_DEFINITION_V2,
  configVersion: 2,
  configSchema: generateSchemaDocument(CORE_SCHEDULE_CONFIG_SCHEMA_V2),
  inputSchema: generateSchemaDocument(CORE_SCHEDULE_INPUT_SCHEMA_V2),
  outputSchema: generateSchemaDocument(CORE_SCHEDULE_OUTPUT_SCHEMA_V2),
  executor: CORE_SCHEDULE_EXECUTOR_V2,
  executorAbi: 1,
});

export const CORE_SCHEDULE_MANIFEST_V3: NodeManifestV2 = Object.freeze({
  ...CORE_SCHEDULE_MANIFEST_V2,
  definition: CORE_SCHEDULE_DEFINITION_V3,
  configVersion: 3,
  configSchema: generateSchemaDocument(CORE_SCHEDULE_CONFIG_SCHEMA_V2, {
    runtimeOnlySemantics: [
      'Cron expressions use exactly five trimmed fields, reject unsupported H, ?, #, and L tokens, and must parse under the selected canonical non-fixed-offset IANA timezone.',
    ],
  }),
  executor: CORE_SCHEDULE_EXECUTOR_V3,
  executorAbi: 1,
});
