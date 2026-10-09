import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_FOR_EACH_EXECUTOR } from './definition.js';
import type { CoreForEachInput } from './validation.js';

export const coreForEachExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_FOR_EACH_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const input = invocation.input as CoreForEachInput;
    return Promise.resolve({
      items: input.items,
      iterationCount: input.items.length,
    });
  },
});
