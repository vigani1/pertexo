import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_WORKFLOW_ERROR_EXECUTOR } from './definition.js';

export const coreWorkflowErrorExecutor: NodeExecutorRegistration =
  Object.freeze({
    executor: CORE_WORKFLOW_ERROR_EXECUTOR,
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
      Promise.resolve(invocation.input),
  });
