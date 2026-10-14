import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_SCHEDULE_EXECUTOR } from './definition.js';

export const coreScheduleExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_SCHEDULE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
