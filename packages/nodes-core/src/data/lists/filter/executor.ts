import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_FILTER_EXECUTOR } from './definition.js';
import type { CoreFilterConfig, CoreFilterInput } from './validation.js';
import { filterItems } from '../semantics/filter.js';
export const coreFilterExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_FILTER_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(
      filterItems(
        invocation.config as CoreFilterConfig,
        invocation.input as CoreFilterInput,
        invocation.signal,
      ),
    ),
});
