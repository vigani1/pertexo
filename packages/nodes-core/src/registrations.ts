import { coreRunValuesExecutor } from './data/run-values/run-values.executor.js';
import { coreCreateFileExecutor } from './data/create-file/create-file.executor.js';
import { UTILITY_EXECUTORS } from './data/utilities/executors.js';
import { DATA_TABLE_EXECUTORS } from './data/tables/executors.js';
import { coreCodeExecutor } from './data/code/code.executor.js';
import { coreRespondWebhookExecutor } from './flow/respond-webhook/respond-webhook.executor.js';
import { coreRequestInputExecutor } from './flow/request-input/request-input.executor.js';
import { coreFormExecutor } from './triggers/form/form.executor.js';
import { coreApprovalExecutor } from './flow/approval/approval.executor.js';
import { coreWorkflowErrorExecutor } from './triggers/workflow-error/workflow-error.executor.js';
import { coreReadFileExecutor } from './data/read-file/read-file.executor.js';
import { coreConcatExecutor } from './data/lists/concat/concat.executor.js';
import { coreTakeExecutor } from './data/lists/take/take.executor.js';
import { coreBatchExecutor } from './data/lists/batch/batch.executor.js';
import { coreFilterExecutor } from './data/lists/filter/filter.executor.js';
import { coreSortExecutor } from './data/lists/sort/sort.executor.js';
import { coreUniqueExecutor } from './data/lists/unique/unique.executor.js';
import { coreSummarizeExecutor } from './data/lists/summarize/summarize.executor.js';
import { coreDateExecutor } from './data/date/date.executor.js';
import type { NodeExecutorRegistration } from '@pertexo/node-sdk/server';

import { coreCallExecutor } from './flow/call/call.executor.js';
import { coreConditionExecutor } from './flow/condition/condition.executor.js';
import { coreForEachExecutor } from './flow/for-each/for-each.executor.js';
import { coreManualExecutor } from './triggers/manual/manual.executor.js';
import { coreMergeExecutor } from './flow/merge/merge.executor.js';
import { coreParallelExecutor } from './flow/parallel/parallel.executor.js';
import { coreScheduleExecutor } from './triggers/schedule/schedule.executor.js';
import { coreSetExecutor } from './data/set/set.executor.js';
import { coreSwitchExecutor } from './flow/switch/switch.executor.js';
import { coreTerminateExecutor } from './flow/terminate/terminate.executor.js';
import { coreValidateExecutor } from './data/validate/validate.executor.js';
import { coreWaitExecutor } from './flow/wait/wait.executor.js';
import { coreWebhookExecutor } from './triggers/webhook/webhook.executor.js';

/** One implementation per core executor, in definition order. */
export const CORE_NODE_EXECUTOR_REGISTRATIONS: readonly NodeExecutorRegistration[] =
  Object.freeze([
    coreRunValuesExecutor,
    coreCreateFileExecutor,
    ...DATA_TABLE_EXECUTORS,
    ...UTILITY_EXECUTORS,
    coreCodeExecutor,
    coreRespondWebhookExecutor,
    coreRequestInputExecutor,
    coreFormExecutor,
    coreApprovalExecutor,
    coreWorkflowErrorExecutor,
    coreReadFileExecutor,
    coreConcatExecutor,
    coreTakeExecutor,
    coreBatchExecutor,
    coreFilterExecutor,
    coreSortExecutor,
    coreUniqueExecutor,
    coreSummarizeExecutor,
    coreDateExecutor,
    coreCallExecutor,
    coreScheduleExecutor,
    coreWebhookExecutor,
    coreWaitExecutor,
    coreForEachExecutor,
    coreMergeExecutor,
    coreParallelExecutor,
    coreSwitchExecutor,
    coreConditionExecutor,
    coreManualExecutor,
    coreSetExecutor,
    coreTerminateExecutor,
    coreValidateExecutor,
  ]);
