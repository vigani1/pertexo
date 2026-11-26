import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';
import { withInlineVersion } from './inline-definition.js';
import { UTILITY_DEFINITIONS } from '../data/utilities/utilities.definition.js';
import { DATA_TABLE_DEFINITIONS } from '../data/tables/data-tables.definition.js';
import { CORE_RUN_VALUES_REGISTRATION } from '../data/run-values/run-values.definition.js';
import { CORE_CREATE_FILE_REGISTRATION } from '../data/create-file/create-file.definition.js';
import { CORE_CODE_REGISTRATION } from '../data/code/code.definition.js';
import { CORE_RESPOND_WEBHOOK_REGISTRATION } from '../flow/respond-webhook/respond-webhook.definition.js';
import { CORE_REQUEST_INPUT_REGISTRATION } from '../flow/request-input/request-input.definition.js';
import { CORE_FORM_REGISTRATION } from '../triggers/form/form.definition.js';
import { CORE_APPROVAL_REGISTRATION } from '../flow/approval/approval.definition.js';
import { CORE_WORKFLOW_ERROR_REGISTRATION } from '../triggers/workflow-error/workflow-error.definition.js';
import { CORE_READ_FILE_REGISTRATION } from '../data/read-file/read-file.definition.js';
import { CORE_CONCAT_REGISTRATION } from '../data/lists/concat/concat.definition.js';
import { CORE_TAKE_REGISTRATION } from '../data/lists/take/take.definition.js';
import { CORE_BATCH_REGISTRATION } from '../data/lists/batch/batch.definition.js';
import { CORE_FILTER_REGISTRATION } from '../data/lists/filter/filter.definition.js';
import { CORE_SORT_REGISTRATION } from '../data/lists/sort/sort.definition.js';
import { CORE_UNIQUE_REGISTRATION } from '../data/lists/unique/unique.definition.js';
import { CORE_SUMMARIZE_REGISTRATION } from '../data/lists/summarize/summarize.definition.js';
import { CORE_DATE_REGISTRATION } from '../data/date/date.definition.js';
import { CORE_CALL_REGISTRATION } from '../flow/call/call.definition.js';
import { CORE_CONDITION_REGISTRATION } from '../flow/condition/condition.definition.js';
import { CORE_FOR_EACH_REGISTRATION } from '../flow/for-each/for-each.definition.js';
import { CORE_MANUAL_REGISTRATION } from '../triggers/manual/manual.definition.js';
import { CORE_MERGE_REGISTRATION } from '../flow/merge/merge.definition.js';
import { CORE_PARALLEL_REGISTRATION } from '../flow/parallel/parallel.definition.js';
import { CORE_SCHEDULE_REGISTRATION } from '../triggers/schedule/schedule.definition.js';
import { CORE_SET_REGISTRATION } from '../data/set/set.definition.js';
import { CORE_SWITCH_REGISTRATION } from '../flow/switch/switch.definition.js';
import { CORE_TERMINATE_REGISTRATION } from '../flow/terminate/terminate.definition.js';
import { CORE_VALIDATE_REGISTRATION } from '../data/validate/validate.definition.js';
import { CORE_WAIT_REGISTRATION } from '../flow/wait/wait.definition.js';
import { CORE_WEBHOOK_REGISTRATION } from '../triggers/webhook/webhook.definition.js';

export const CORE_NODE_DEFINITION_REGISTRATIONS: readonly NodeDefinitionRegistration[] =
  Object.freeze([
    CORE_RUN_VALUES_REGISTRATION,
    CORE_CREATE_FILE_REGISTRATION,
    ...DATA_TABLE_DEFINITIONS,
    ...UTILITY_DEFINITIONS,
    CORE_CODE_REGISTRATION,
    CORE_RESPOND_WEBHOOK_REGISTRATION,
    CORE_REQUEST_INPUT_REGISTRATION,
    CORE_FORM_REGISTRATION,
    CORE_APPROVAL_REGISTRATION,
    CORE_WORKFLOW_ERROR_REGISTRATION,
    CORE_READ_FILE_REGISTRATION,
    ...withInlineVersion(CORE_CONCAT_REGISTRATION),
    ...withInlineVersion(CORE_TAKE_REGISTRATION),
    ...withInlineVersion(CORE_BATCH_REGISTRATION),
    ...withInlineVersion(CORE_FILTER_REGISTRATION),
    ...withInlineVersion(CORE_SORT_REGISTRATION),
    ...withInlineVersion(CORE_UNIQUE_REGISTRATION),
    ...withInlineVersion(CORE_SUMMARIZE_REGISTRATION),
    ...withInlineVersion(CORE_DATE_REGISTRATION),
    CORE_CALL_REGISTRATION,
    CORE_SCHEDULE_REGISTRATION,
    CORE_WEBHOOK_REGISTRATION,
    CORE_WAIT_REGISTRATION,
    CORE_FOR_EACH_REGISTRATION,
    ...withInlineVersion(CORE_MERGE_REGISTRATION),
    CORE_PARALLEL_REGISTRATION,
    ...withInlineVersion(CORE_SWITCH_REGISTRATION),
    ...withInlineVersion(CORE_CONDITION_REGISTRATION),
    CORE_MANUAL_REGISTRATION,
    ...withInlineVersion(CORE_SET_REGISTRATION),
    CORE_TERMINATE_REGISTRATION,
    ...withInlineVersion(CORE_VALIDATE_REGISTRATION),
  ]);
