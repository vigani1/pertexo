import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_MANUAL_EXECUTOR } from './definition.js';

export const coreManualExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_MANUAL_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
