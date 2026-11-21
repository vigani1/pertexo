import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { inlineCoreExecutor } from '../../catalog/inline-registration.js';
import { CORE_MERGE_EXECUTOR } from './merge.definition.js';
import { executeMerge, inlineMerge } from './merge-kernel.js';

export const coreMergeExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_MERGE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(executeMerge(invocation.input)),
});

export const coreMergeInlineExecutor = inlineCoreExecutor(coreMergeExecutor, {
  executeInline: inlineMerge,
});
