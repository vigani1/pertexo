import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_CONDITION_EXECUTOR } from './definition.js';

export const coreConditionExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_CONDITION_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const input = invocation.input as { readonly condition: boolean };
    return Promise.resolve({
      selectedPort: input.condition ? ('true' as const) : ('false' as const),
    });
  },
});
