import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_TERMINATE_EXECUTOR } from './definition.js';

export const coreTerminateExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_TERMINATE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
