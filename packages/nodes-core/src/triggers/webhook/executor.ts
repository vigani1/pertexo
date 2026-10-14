import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_WEBHOOK_EXECUTOR } from './definition.js';

export const coreWebhookExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_WEBHOOK_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
