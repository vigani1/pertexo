import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { HTTP_POLL_TRIGGER } from '@pertexo/workflow-model';

export const httpPollExecutor: NodeExecutorRegistration = Object.freeze({
  executor: HTTP_POLL_TRIGGER,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
