import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import { CORE_WAIT_DEFINITION, CORE_WAIT_EXECUTOR } from './definition.js';

export const coreWaitExecutor: NodeExecutorRegistration = Object.freeze({
  abiVersion: 1,
  definitions: Object.freeze([CORE_WAIT_DEFINITION]),
  executor: CORE_WAIT_EXECUTOR,
  lifecycle: 'active',
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});
