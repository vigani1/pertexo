import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import type { TaskContext } from '@pertexo/workflow-model';
import { CORE_APPROVAL_EXECUTOR } from './definition.js';

/** Only declares the task; the coordinator owns the eventual decision. */
export const coreApprovalExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_APPROVAL_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve({
      pending: true,
      context: invocation.input as TaskContext,
    }),
});
