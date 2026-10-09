import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_MERGE_EXECUTOR } from './definition.js';

export const coreMergeExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_MERGE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
