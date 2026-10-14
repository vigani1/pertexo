import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_SORT_EXECUTOR } from './definition.js';
import type { CoreSortConfig, CoreSortInput } from './validation.js';
import { sortItems } from '../semantics/sort.js';
export const coreSortExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_SORT_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(
      sortItems(
        invocation.config as CoreSortConfig,
        invocation.input as CoreSortInput,
        invocation.signal,
      ),
    ),
});
