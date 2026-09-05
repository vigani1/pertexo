import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_MERGE_DEFINITION,
  CORE_MERGE_DEFINITION_V2,
  CORE_MERGE_EXECUTOR,
  CORE_MERGE_EXECUTOR_V2,
} from './definition.js';

export const coreMergeExecutor: NodeExecutorRegistration = Object.freeze({
  abiVersion: 1,
  definitions: Object.freeze([CORE_MERGE_DEFINITION]),
  executor: CORE_MERGE_EXECUTOR,
  lifecycle: 'active',
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});

export const coreMergeExecutorV2: NodeExecutorRegistration = Object.freeze({
  ...coreMergeExecutor,
  definitions: Object.freeze([CORE_MERGE_DEFINITION_V2]),
  executor: CORE_MERGE_EXECUTOR_V2,
});
