import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_PARALLEL_EXECUTOR } from './definition.js';
import type { ParallelConfig } from '@pertexo/workflow-model';

export const coreParallelExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_PARALLEL_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const config = invocation.config as ParallelConfig;
    return Promise.resolve({
      branchIds: config.branches.map(({ id }) => id),
    });
  },
});
