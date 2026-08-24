import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_FOR_EACH_DEFINITION,
  CORE_FOR_EACH_EXECUTOR,
} from './definition.js';
import type { CoreForEachInput } from './validation.js';

export const coreForEachExecutor: NodeExecutorRegistration = Object.freeze({
  abiVersion: 1,
  definitions: Object.freeze([CORE_FOR_EACH_DEFINITION]),
  executor: CORE_FOR_EACH_EXECUTOR,
  lifecycle: 'active',
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const input = invocation.input as CoreForEachInput;
    return Promise.resolve({
      items: input.items,
      iterationCount: input.items.length,
    });
  },
});
