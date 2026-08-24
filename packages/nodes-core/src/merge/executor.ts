import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import { CORE_MERGE_DEFINITION, CORE_MERGE_EXECUTOR } from './definition.js';

export const coreMergeExecutor: NodeExecutorRegistration = Object.freeze({
  abiVersion: 1,
  definitions: Object.freeze([CORE_MERGE_DEFINITION]),
  executor: CORE_MERGE_EXECUTOR,
  lifecycle: 'active',
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
