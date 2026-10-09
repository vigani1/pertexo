import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_SET_EXECUTOR } from './definition.js';

export const coreSetExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_SET_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
