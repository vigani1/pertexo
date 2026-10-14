import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_UNIQUE_EXECUTOR } from './definition.js';
import type { CoreUniqueConfig, CoreUniqueInput } from './validation.js';
import { uniqueItems } from '../semantics/unique.js';
export const coreUniqueExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_UNIQUE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(
      uniqueItems(
        invocation.config as CoreUniqueConfig,
        invocation.input as CoreUniqueInput,
        invocation.signal,
      ),
    ),
});
