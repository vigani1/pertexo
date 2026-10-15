import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_FORM_EXECUTOR } from './definition.js';
export const coreFormExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_FORM_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
