import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_PARALLEL_DEFINITION,
  CORE_PARALLEL_DEFINITION_V2,
  CORE_PARALLEL_DEFINITION_V3,
  CORE_PARALLEL_EXECUTOR,
  CORE_PARALLEL_EXECUTOR_V2,
  CORE_PARALLEL_EXECUTOR_V3,
} from './definition.js';
import type { CoreParallelConfig } from './validation.js';

export const coreParallelExecutor: NodeExecutorRegistration = Object.freeze({
  abiVersion: 1,
  definitions: Object.freeze([CORE_PARALLEL_DEFINITION]),
  executor: CORE_PARALLEL_EXECUTOR,
  lifecycle: 'active',
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const config = invocation.config as CoreParallelConfig;
    return Promise.resolve({
      branchIds: config.branches.map(({ id }) => id),
    });
  },
});

export const coreParallelExecutorV2: NodeExecutorRegistration = Object.freeze({
  ...coreParallelExecutor,
  definitions: Object.freeze([CORE_PARALLEL_DEFINITION_V2]),
  executor: CORE_PARALLEL_EXECUTOR_V2,
});

export const coreParallelExecutorV3: NodeExecutorRegistration = Object.freeze({
  ...coreParallelExecutor,
  definitions: Object.freeze([CORE_PARALLEL_DEFINITION_V3]),
  executor: CORE_PARALLEL_EXECUTOR_V3,
});
