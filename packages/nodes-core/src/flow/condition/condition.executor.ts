import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { inlineCoreExecutor } from '../../catalog/inline-registration.js';
import { CORE_CONDITION_EXECUTOR } from './condition.definition.js';
import { executeCondition, inlineCondition } from './condition-kernel.js';

export const coreConditionExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_CONDITION_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(executeCondition(invocation.input)),
});

export const coreConditionInlineExecutor = inlineCoreExecutor(
  coreConditionExecutor,
  {
    executeInline: inlineCondition,
  },
);
