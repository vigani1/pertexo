import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_WAIT_EXECUTOR } from './definition.js';

export const coreWaitExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_WAIT_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
