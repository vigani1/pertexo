import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_SWITCH_EXECUTOR } from './definition.js';
import type { SwitchConfig } from '@pertexo/workflow-model';
import type { CoreSwitchInput } from './validation.js';

export const coreSwitchExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_SWITCH_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const config = invocation.config as SwitchConfig;
    const input = invocation.input as CoreSwitchInput;
    const selectedPort =
      config.cases.find(({ equals }) => equals === input.value)?.id ??
      'default';
    return Promise.resolve({ selectedPort });
  },
});
