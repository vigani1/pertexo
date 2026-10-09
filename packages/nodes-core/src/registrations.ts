import type { NodeExecutorRegistration } from '@pertexo/node-sdk/server';

import { coreConditionExecutor } from './condition/executor.js';
import { coreForEachExecutor } from './for-each/executor.js';
import { coreManualExecutor } from './manual/executor.js';
import { coreMergeExecutor } from './merge/executor.js';
import { coreParallelExecutor } from './parallel/executor.js';
import { coreScheduleExecutor } from './schedule/executor.js';
import { coreSetExecutor } from './set/executor.js';
import { coreSwitchExecutor } from './switch/executor.js';
import { coreTerminateExecutor } from './terminate/executor.js';
import { coreValidateExecutor } from './validate/executor.js';
import { coreWaitExecutor } from './wait/executor.js';
import { coreWebhookExecutor } from './webhook/executor.js';

/** One implementation per core executor, in definition order. */
export const CORE_NODE_EXECUTOR_REGISTRATIONS: readonly NodeExecutorRegistration[] =
  Object.freeze([
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
