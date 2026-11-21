import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
  JsonValue,
} from '@pertexo/node-sdk/server';
import { inlineCoreExecutor } from '../../catalog/inline-registration.js';
import { CORE_SET_EXECUTOR } from './set.definition.js';
import { executeSet, inlineSet } from './set-kernel.js';

export const coreSetExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_SET_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(executeSet(invocation.input as JsonValue)),
});

export const coreSetInlineExecutor = inlineCoreExecutor(coreSetExecutor, {
  executeInline: inlineSet,
});
