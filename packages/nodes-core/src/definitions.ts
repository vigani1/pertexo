import { DATA_TABLE_DEFINITIONS } from './data/tables/definitions.js';
import {
  CORE_CODE_MANIFEST,
  CORE_CODE_CONFIG_SCHEMA,
  CORE_CODE_INPUT_SCHEMA,
  CORE_CODE_OUTPUT_SCHEMA,
} from './data/code/index.js';
import {
  CORE_RESPOND_WEBHOOK_MANIFEST,
  CORE_RESPOND_WEBHOOK_CONFIG_SCHEMA,
  CORE_RESPOND_WEBHOOK_INPUT_SCHEMA,
  CORE_RESPOND_WEBHOOK_OUTPUT_SCHEMA,
} from './flow/respond-webhook/index.js';
import {
  CORE_REQUEST_INPUT_MANIFEST,
  CORE_REQUEST_INPUT_CONFIG_SCHEMA,
  CORE_REQUEST_INPUT_INPUT_SCHEMA,
  CORE_REQUEST_INPUT_OUTPUT_SCHEMA,
} from './flow/request-input/index.js';
import {
  CORE_FORM_MANIFEST,
  CORE_FORM_CONFIG_SCHEMA,
  CORE_FORM_INPUT_SCHEMA,
  CORE_FORM_OUTPUT_SCHEMA,
} from './triggers/form/index.js';
import {
  CORE_APPROVAL_MANIFEST,
  CORE_APPROVAL_CONFIG_SCHEMA,
  CORE_APPROVAL_INPUT_SCHEMA,
  CORE_APPROVAL_OUTPUT_SCHEMA,
} from './flow/approval/index.js';
import {
  CORE_WORKFLOW_ERROR_MANIFEST,
  CORE_WORKFLOW_ERROR_CONFIG_SCHEMA,
  CORE_WORKFLOW_ERROR_INPUT_SCHEMA,
  CORE_WORKFLOW_ERROR_OUTPUT_SCHEMA,
} from './triggers/workflow-error/index.js';
import {
  CORE_READ_FILE_MANIFEST,
  CORE_READ_FILE_CONFIG_SCHEMA,
  CORE_READ_FILE_INPUT_SCHEMA,
  CORE_READ_FILE_OUTPUT_SCHEMA,
} from './data/read-file/index.js';
import {
  CORE_CONCAT_CONFIG_SCHEMA,
  CORE_CONCAT_INPUT_SCHEMA,
  CORE_CONCAT_MANIFEST,
  CORE_CONCAT_OUTPUT_SCHEMA,
} from './data/lists/concat/index.js';
import {
  CORE_TAKE_CONFIG_SCHEMA,
  CORE_TAKE_INPUT_SCHEMA,
  CORE_TAKE_MANIFEST,
  CORE_TAKE_OUTPUT_SCHEMA,
} from './data/lists/take/index.js';
import {
  CORE_BATCH_CONFIG_SCHEMA,
  CORE_BATCH_INPUT_SCHEMA,
  CORE_BATCH_MANIFEST,
  CORE_BATCH_OUTPUT_SCHEMA,
} from './data/lists/batch/index.js';
import {
  CORE_FILTER_CONFIG_SCHEMA,
  CORE_FILTER_INPUT_SCHEMA,
  CORE_FILTER_MANIFEST,
  CORE_FILTER_OUTPUT_SCHEMA,
} from './data/lists/filter/index.js';
import {
  CORE_SORT_CONFIG_SCHEMA,
  CORE_SORT_INPUT_SCHEMA,
  CORE_SORT_MANIFEST,
  CORE_SORT_OUTPUT_SCHEMA,
} from './data/lists/sort/index.js';
import {
  CORE_UNIQUE_CONFIG_SCHEMA,
  CORE_UNIQUE_INPUT_SCHEMA,
  CORE_UNIQUE_MANIFEST,
  CORE_UNIQUE_OUTPUT_SCHEMA,
} from './data/lists/unique/index.js';
import {
  CORE_SUMMARIZE_CONFIG_SCHEMA,
  CORE_SUMMARIZE_INPUT_SCHEMA,
  CORE_SUMMARIZE_MANIFEST,
  CORE_SUMMARIZE_OUTPUT_SCHEMA,
} from './data/lists/summarize/index.js';
import {
  CORE_DATE_CONFIG_SCHEMA,
  CORE_DATE_INPUT_SCHEMA,
  CORE_DATE_MANIFEST,
  CORE_DATE_OUTPUT_SCHEMA,
} from './data/date/index.js';
import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';

import {
  CORE_CALL_CONFIG_SCHEMA,
  CORE_CALL_INPUT_SCHEMA,
  CORE_CALL_MANIFEST,
  CORE_CALL_OUTPUT_SCHEMA,
} from './flow/call/index.js';

import {
  CORE_CONDITION_CONFIG_SCHEMA,
  CORE_CONDITION_INPUT_SCHEMA,
  CORE_CONDITION_MANIFEST,
  CORE_CONDITION_OUTPUT_SCHEMA,
} from './flow/condition/index.js';
import {
  CORE_FOR_EACH_CONFIG_SCHEMA,
  CORE_FOR_EACH_INPUT_SCHEMA,
  CORE_FOR_EACH_MANIFEST,
  CORE_FOR_EACH_OUTPUT_SCHEMA,
} from './flow/for-each/index.js';
import {
  CORE_MANUAL_CONFIG_SCHEMA,
  CORE_MANUAL_INPUT_SCHEMA,
  CORE_MANUAL_MANIFEST,
  CORE_MANUAL_OUTPUT_SCHEMA,
} from './triggers/manual/index.js';
import {
  CORE_MERGE_CONFIG_SCHEMA,
  CORE_MERGE_INPUT_SCHEMA,
  CORE_MERGE_MANIFEST,
  CORE_MERGE_OUTPUT_SCHEMA,
} from './flow/merge/index.js';
import {
  CORE_PARALLEL_CONFIG_SCHEMA,
  CORE_PARALLEL_INPUT_SCHEMA,
  CORE_PARALLEL_MANIFEST,
  CORE_PARALLEL_OUTPUT_SCHEMA,
} from './flow/parallel/index.js';
import {
  CORE_SCHEDULE_CONFIG_SCHEMA,
  CORE_SCHEDULE_INPUT_SCHEMA,
  CORE_SCHEDULE_MANIFEST,
  CORE_SCHEDULE_OUTPUT_SCHEMA,
} from './triggers/schedule/index.js';
import {
  CORE_SET_CONFIG_SCHEMA,
  CORE_SET_INPUT_SCHEMA,
  CORE_SET_MANIFEST,
  CORE_SET_OUTPUT_SCHEMA,
} from './data/set/index.js';
import {
  CORE_SWITCH_CONFIG_SCHEMA,
  CORE_SWITCH_INPUT_SCHEMA,
  CORE_SWITCH_MANIFEST,
  CORE_SWITCH_OUTPUT_SCHEMA,
} from './flow/switch/index.js';
import {
  CORE_TERMINATE_CONFIG_SCHEMA,
  CORE_TERMINATE_INPUT_SCHEMA,
  CORE_TERMINATE_MANIFEST,
  CORE_TERMINATE_OUTPUT_SCHEMA,
} from './flow/terminate/index.js';
import {
  CORE_VALIDATE_CONFIG_SCHEMA,
  CORE_VALIDATE_INPUT_SCHEMA,
  CORE_VALIDATE_MANIFEST,
  CORE_VALIDATE_OUTPUT_SCHEMA,
} from './data/validate/index.js';
import {
  CORE_WAIT_CONFIG_SCHEMA,
  CORE_WAIT_INPUT_SCHEMA,
  CORE_WAIT_MANIFEST,
  CORE_WAIT_OUTPUT_SCHEMA,
} from './flow/wait/index.js';
import {
  CORE_WEBHOOK_CONFIG_SCHEMA,
  CORE_WEBHOOK_INPUT_SCHEMA,
  CORE_WEBHOOK_MANIFEST,
  CORE_WEBHOOK_OUTPUT_SCHEMA,
} from './triggers/webhook/index.js';

export const CORE_NODE_DEFINITION_REGISTRATIONS: readonly NodeDefinitionRegistration[] =
  Object.freeze([
    ...DATA_TABLE_DEFINITIONS,
    Object.freeze({
      manifest: CORE_CODE_MANIFEST,
      configSchema: CORE_CODE_CONFIG_SCHEMA,
      inputSchema: CORE_CODE_INPUT_SCHEMA,
      outputSchema: CORE_CODE_OUTPUT_SCHEMA,
    }),
    {
      manifest: CORE_RESPOND_WEBHOOK_MANIFEST,
      configSchema: CORE_RESPOND_WEBHOOK_CONFIG_SCHEMA,
      inputSchema: CORE_RESPOND_WEBHOOK_INPUT_SCHEMA,
      outputSchema: CORE_RESPOND_WEBHOOK_OUTPUT_SCHEMA,
    },
    Object.freeze({
      manifest: CORE_REQUEST_INPUT_MANIFEST,
      configSchema: CORE_REQUEST_INPUT_CONFIG_SCHEMA,
      inputSchema: CORE_REQUEST_INPUT_INPUT_SCHEMA,
      outputSchema: CORE_REQUEST_INPUT_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_FORM_MANIFEST,
      configSchema: CORE_FORM_CONFIG_SCHEMA,
      inputSchema: CORE_FORM_INPUT_SCHEMA,
      outputSchema: CORE_FORM_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_APPROVAL_MANIFEST,
      configSchema: CORE_APPROVAL_CONFIG_SCHEMA,
      inputSchema: CORE_APPROVAL_INPUT_SCHEMA,
      outputSchema: CORE_APPROVAL_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_WORKFLOW_ERROR_MANIFEST,
      configSchema: CORE_WORKFLOW_ERROR_CONFIG_SCHEMA,
      inputSchema: CORE_WORKFLOW_ERROR_INPUT_SCHEMA,
      outputSchema: CORE_WORKFLOW_ERROR_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_READ_FILE_MANIFEST,
      configSchema: CORE_READ_FILE_CONFIG_SCHEMA,
      inputSchema: CORE_READ_FILE_INPUT_SCHEMA,
      outputSchema: CORE_READ_FILE_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_CONCAT_MANIFEST,
      configSchema: CORE_CONCAT_CONFIG_SCHEMA,
      inputSchema: CORE_CONCAT_INPUT_SCHEMA,
      outputSchema: CORE_CONCAT_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_TAKE_MANIFEST,
      configSchema: CORE_TAKE_CONFIG_SCHEMA,
      inputSchema: CORE_TAKE_INPUT_SCHEMA,
      outputSchema: CORE_TAKE_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_BATCH_MANIFEST,
      configSchema: CORE_BATCH_CONFIG_SCHEMA,
      inputSchema: CORE_BATCH_INPUT_SCHEMA,
      outputSchema: CORE_BATCH_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_FILTER_MANIFEST,
      configSchema: CORE_FILTER_CONFIG_SCHEMA,
      inputSchema: CORE_FILTER_INPUT_SCHEMA,
      outputSchema: CORE_FILTER_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_SORT_MANIFEST,
      configSchema: CORE_SORT_CONFIG_SCHEMA,
      inputSchema: CORE_SORT_INPUT_SCHEMA,
      outputSchema: CORE_SORT_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_UNIQUE_MANIFEST,
      configSchema: CORE_UNIQUE_CONFIG_SCHEMA,
      inputSchema: CORE_UNIQUE_INPUT_SCHEMA,
      outputSchema: CORE_UNIQUE_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_SUMMARIZE_MANIFEST,
      configSchema: CORE_SUMMARIZE_CONFIG_SCHEMA,
      inputSchema: CORE_SUMMARIZE_INPUT_SCHEMA,
      outputSchema: CORE_SUMMARIZE_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_DATE_MANIFEST,
      configSchema: CORE_DATE_CONFIG_SCHEMA,
      inputSchema: CORE_DATE_INPUT_SCHEMA,
      outputSchema: CORE_DATE_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_CALL_MANIFEST,
      configSchema: CORE_CALL_CONFIG_SCHEMA,
      inputSchema: CORE_CALL_INPUT_SCHEMA,
      outputSchema: CORE_CALL_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_SCHEDULE_MANIFEST,
      configSchema: CORE_SCHEDULE_CONFIG_SCHEMA,
      inputSchema: CORE_SCHEDULE_INPUT_SCHEMA,
      outputSchema: CORE_SCHEDULE_OUTPUT_SCHEMA,
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
      manifest: CORE_PARALLEL_MANIFEST,
      configSchema: CORE_PARALLEL_CONFIG_SCHEMA,
      inputSchema: CORE_PARALLEL_INPUT_SCHEMA,
      outputSchema: CORE_PARALLEL_OUTPUT_SCHEMA,
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
    Object.freeze({
      manifest: CORE_VALIDATE_MANIFEST,
      configSchema: CORE_VALIDATE_CONFIG_SCHEMA,
      inputSchema: CORE_VALIDATE_INPUT_SCHEMA,
      outputSchema: CORE_VALIDATE_OUTPUT_SCHEMA,
    }),
  ]);
