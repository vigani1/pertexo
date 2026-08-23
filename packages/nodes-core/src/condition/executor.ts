import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from '../policies.js';
import {
  CORE_CONDITION_DEFINITION,
  CORE_CONDITION_EXECUTOR,
} from './definition.js';

export const coreConditionExecutor: NodeExecutorRegistration = Object.freeze({
  abiVersion: 1,
  definitions: Object.freeze([CORE_CONDITION_DEFINITION]),
  executor: CORE_CONDITION_EXECUTOR,
  lifecycle: 'active',
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const input = invocation.input as { readonly condition: boolean };
    return Promise.resolve({
      selectedPort: input.condition ? ('true' as const) : ('false' as const),
    });
  },
});
