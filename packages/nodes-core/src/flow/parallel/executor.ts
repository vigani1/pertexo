import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_PARALLEL_EXECUTOR } from './definition.js';
import type { CoreParallelConfig } from './validation.js';

export const coreParallelExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_PARALLEL_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const config = invocation.config as CoreParallelConfig;
    return Promise.resolve({
      branchIds: config.branches.map(({ id }) => id),
    });
  },
});
