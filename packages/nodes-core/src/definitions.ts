import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';

import {
  CORE_CONDITION_CONFIG_SCHEMA,
  CORE_CONDITION_INPUT_SCHEMA,
  CORE_CONDITION_MANIFEST,
  CORE_CONDITION_OUTPUT_SCHEMA,
} from './condition/index.js';
import {
  CORE_FOR_EACH_CONFIG_SCHEMA,
  CORE_FOR_EACH_INPUT_SCHEMA,
  CORE_FOR_EACH_MANIFEST,
  CORE_FOR_EACH_OUTPUT_SCHEMA,
} from './for-each/index.js';
import {
  CORE_MANUAL_CONFIG_SCHEMA,
  CORE_MANUAL_INPUT_SCHEMA,
  CORE_MANUAL_MANIFEST,
  CORE_MANUAL_OUTPUT_SCHEMA,
} from './manual/index.js';
import {
  CORE_MERGE_CONFIG_SCHEMA,
  CORE_MERGE_INPUT_SCHEMA,
  CORE_MERGE_MANIFEST,
  CORE_MERGE_MANIFEST_V2,
  CORE_MERGE_MANIFEST_V3,
  CORE_MERGE_OUTPUT_SCHEMA,
  CORE_MERGE_OUTPUT_SCHEMA_V2,
  CORE_MERGE_INPUT_SCHEMA_V2,
} from './merge/index.js';
import {
  CORE_PARALLEL_CONFIG_SCHEMA,
  CORE_PARALLEL_INPUT_SCHEMA,
  CORE_PARALLEL_MANIFEST,
  CORE_PARALLEL_MANIFEST_V2,
  CORE_PARALLEL_MANIFEST_V3,
  CORE_PARALLEL_OUTPUT_SCHEMA,
  CORE_PARALLEL_OUTPUT_SCHEMA_V2,
} from './parallel/index.js';
import {
  CORE_SCHEDULE_CONFIG_SCHEMA,
  CORE_SCHEDULE_INPUT_SCHEMA,
  CORE_SCHEDULE_MANIFEST,
  CORE_SCHEDULE_MANIFEST_V2,
  CORE_SCHEDULE_MANIFEST_V3,
  CORE_SCHEDULE_OUTPUT_SCHEMA,
  CORE_SCHEDULE_CONFIG_SCHEMA_V2,
  CORE_SCHEDULE_INPUT_SCHEMA_V2,
  CORE_SCHEDULE_OUTPUT_SCHEMA_V2,
} from './schedule/index.js';
import {
  CORE_SET_CONFIG_SCHEMA,
  CORE_SET_INPUT_SCHEMA,
  CORE_SET_MANIFEST,
  CORE_SET_OUTPUT_SCHEMA,
} from './set/index.js';
import {
  CORE_SWITCH_CONFIG_SCHEMA,
  CORE_SWITCH_INPUT_SCHEMA,
  CORE_SWITCH_MANIFEST,
  CORE_SWITCH_OUTPUT_SCHEMA,
} from './switch/index.js';
import {
  CORE_TERMINATE_CONFIG_SCHEMA,
  CORE_TERMINATE_INPUT_SCHEMA,
  CORE_TERMINATE_MANIFEST,
  CORE_TERMINATE_OUTPUT_SCHEMA,
} from './terminate/index.js';
import {
  CORE_WAIT_CONFIG_SCHEMA,
  CORE_WAIT_INPUT_SCHEMA,
  CORE_WAIT_MANIFEST,
  CORE_WAIT_OUTPUT_SCHEMA,
} from './wait/index.js';
import {
  CORE_WEBHOOK_CONFIG_SCHEMA,
  CORE_WEBHOOK_INPUT_SCHEMA,
  CORE_WEBHOOK_MANIFEST,
  CORE_WEBHOOK_OUTPUT_SCHEMA,
} from './webhook/index.js';

export const CORE_NODE_DEFINITION_REGISTRATIONS: readonly NodeDefinitionRegistration[] =
  Object.freeze([
    Object.freeze({
      manifest: CORE_SCHEDULE_MANIFEST,
      configSchema: CORE_SCHEDULE_CONFIG_SCHEMA,
      inputSchema: CORE_SCHEDULE_INPUT_SCHEMA,
      outputSchema: CORE_SCHEDULE_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_SCHEDULE_MANIFEST_V2,
      configSchema: CORE_SCHEDULE_CONFIG_SCHEMA_V2,
      inputSchema: CORE_SCHEDULE_INPUT_SCHEMA_V2,
      outputSchema: CORE_SCHEDULE_OUTPUT_SCHEMA_V2,
    }),
    Object.freeze({
      manifest: CORE_SCHEDULE_MANIFEST_V3,
      configSchema: CORE_SCHEDULE_CONFIG_SCHEMA_V2,
      inputSchema: CORE_SCHEDULE_INPUT_SCHEMA_V2,
      outputSchema: CORE_SCHEDULE_OUTPUT_SCHEMA_V2,
    }),
    Object.freeze({
      manifest: CORE_WEBHOOK_MANIFEST,
      configSchema: CORE_WEBHOOK_CONFIG_SCHEMA,
      inputSchema: CORE_WEBHOOK_INPUT_SCHEMA,
      outputSchema: CORE_WEBHOOK_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_WAIT_MANIFEST,
      configSchema: CORE_WAIT_CONFIG_SCHEMA,
      inputSchema: CORE_WAIT_INPUT_SCHEMA,
      outputSchema: CORE_WAIT_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_FOR_EACH_MANIFEST,
      configSchema: CORE_FOR_EACH_CONFIG_SCHEMA,
      inputSchema: CORE_FOR_EACH_INPUT_SCHEMA,
      outputSchema: CORE_FOR_EACH_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_MERGE_MANIFEST,
      configSchema: CORE_MERGE_CONFIG_SCHEMA,
      inputSchema: CORE_MERGE_INPUT_SCHEMA,
      outputSchema: CORE_MERGE_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_MERGE_MANIFEST_V2,
      configSchema: CORE_MERGE_CONFIG_SCHEMA,
      inputSchema: CORE_MERGE_INPUT_SCHEMA_V2,
      outputSchema: CORE_MERGE_OUTPUT_SCHEMA_V2,
    }),
    Object.freeze({
      manifest: CORE_MERGE_MANIFEST_V3,
      configSchema: CORE_MERGE_CONFIG_SCHEMA,
      inputSchema: CORE_MERGE_INPUT_SCHEMA_V2,
      outputSchema: CORE_MERGE_OUTPUT_SCHEMA_V2,
    }),
    Object.freeze({
      manifest: CORE_PARALLEL_MANIFEST,
      configSchema: CORE_PARALLEL_CONFIG_SCHEMA,
      inputSchema: CORE_PARALLEL_INPUT_SCHEMA,
      outputSchema: CORE_PARALLEL_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_PARALLEL_MANIFEST_V2,
      configSchema: CORE_PARALLEL_CONFIG_SCHEMA,
      inputSchema: CORE_PARALLEL_INPUT_SCHEMA,
      outputSchema: CORE_PARALLEL_OUTPUT_SCHEMA_V2,
    }),
    Object.freeze({
      manifest: CORE_PARALLEL_MANIFEST_V3,
      configSchema: CORE_PARALLEL_CONFIG_SCHEMA,
      inputSchema: CORE_PARALLEL_INPUT_SCHEMA,
      outputSchema: CORE_PARALLEL_OUTPUT_SCHEMA_V2,
    }),
    Object.freeze({
      manifest: CORE_SWITCH_MANIFEST,
      configSchema: CORE_SWITCH_CONFIG_SCHEMA,
      inputSchema: CORE_SWITCH_INPUT_SCHEMA,
      outputSchema: CORE_SWITCH_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_CONDITION_MANIFEST,
      configSchema: CORE_CONDITION_CONFIG_SCHEMA,
      inputSchema: CORE_CONDITION_INPUT_SCHEMA,
      outputSchema: CORE_CONDITION_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_MANUAL_MANIFEST,
      configSchema: CORE_MANUAL_CONFIG_SCHEMA,
      inputSchema: CORE_MANUAL_INPUT_SCHEMA,
      outputSchema: CORE_MANUAL_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_SET_MANIFEST,
      configSchema: CORE_SET_CONFIG_SCHEMA,
      inputSchema: CORE_SET_INPUT_SCHEMA,
      outputSchema: CORE_SET_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_TERMINATE_MANIFEST,
      configSchema: CORE_TERMINATE_CONFIG_SCHEMA,
      inputSchema: CORE_TERMINATE_INPUT_SCHEMA,
      outputSchema: CORE_TERMINATE_OUTPUT_SCHEMA,
    }),
  ]);
