import { coreRequestInputExecutor } from './flow/request-input/executor.js';
import { coreFormExecutor } from './triggers/form/executor.js';
import { coreApprovalExecutor } from './flow/approval/executor.js';
import { coreWorkflowErrorExecutor } from './triggers/workflow-error/executor.js';
import { coreReadFileExecutor } from './data/read-file/executor.js';
import { coreConcatExecutor } from './data/lists/concat/executor.js';
import { coreTakeExecutor } from './data/lists/take/executor.js';
import { coreBatchExecutor } from './data/lists/batch/executor.js';
import { coreFilterExecutor } from './data/lists/filter/executor.js';
import { coreSortExecutor } from './data/lists/sort/executor.js';
import { coreUniqueExecutor } from './data/lists/unique/executor.js';
import { coreSummarizeExecutor } from './data/lists/summarize/executor.js';
import { coreDateExecutor } from './data/date/executor.js';
import type { NodeExecutorRegistration } from '@pertexo/node-sdk/server';

import { coreCallExecutor } from './flow/call/executor.js';
import { coreConditionExecutor } from './flow/condition/executor.js';
import { coreForEachExecutor } from './flow/for-each/executor.js';
import { coreManualExecutor } from './triggers/manual/executor.js';
import { coreMergeExecutor } from './flow/merge/executor.js';
import { coreParallelExecutor } from './flow/parallel/executor.js';
import { coreScheduleExecutor } from './triggers/schedule/executor.js';
import { coreSetExecutor } from './data/set/executor.js';
import { coreSwitchExecutor } from './flow/switch/executor.js';
import { coreTerminateExecutor } from './flow/terminate/executor.js';
import { coreValidateExecutor } from './data/validate/executor.js';
import { coreWaitExecutor } from './flow/wait/executor.js';
import { coreWebhookExecutor } from './triggers/webhook/executor.js';

/** One implementation per core executor, in definition order. */
export const CORE_NODE_EXECUTOR_REGISTRATIONS: readonly NodeExecutorRegistration[] =
  Object.freeze([
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
