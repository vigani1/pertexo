import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from '../policies.js';
import { CORE_SWITCH_DEFINITION, CORE_SWITCH_EXECUTOR } from './definition.js';
import type { CoreSwitchConfig, CoreSwitchInput } from './validation.js';

export const coreSwitchExecutor: NodeExecutorRegistration = Object.freeze({
  abiVersion: 1,
  definitions: Object.freeze([CORE_SWITCH_DEFINITION]),
  executor: CORE_SWITCH_EXECUTOR,
  lifecycle: 'active',
  policyReferences: Object.freeze([
    CORE_BOUNDED_JSON_POLICY,
    CORE_JSONATA_POLICY,
  ]),
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const config = invocation.config as CoreSwitchConfig;
    const input = invocation.input as CoreSwitchInput;
    const selectedPort =
      config.cases.find(({ equals }) => equals === input.value)?.id ??
      'default';
    return Promise.resolve({ selectedPort });
  },
});
