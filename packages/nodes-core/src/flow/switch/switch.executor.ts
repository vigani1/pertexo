import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { inlineCoreExecutor } from '../../catalog/inline-registration.js';
import { CORE_SWITCH_EXECUTOR } from './switch.definition.js';
import { executeSwitch, inlineSwitch } from './switch-kernel.js';

export const coreSwitchExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_SWITCH_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(executeSwitch(invocation.config, invocation.input)),
});

export const coreSwitchInlineExecutor = inlineCoreExecutor(coreSwitchExecutor, {
  executeInline: inlineSwitch,
});
