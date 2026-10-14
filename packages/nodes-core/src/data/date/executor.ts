import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_DATE_EXECUTOR } from './definition.js';
import type { CoreDateConfig, CoreDateInput } from './validation.js';
import { transformDateValue } from './semantics.js';
export const coreDateExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_DATE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(
      transformDateValue(
        invocation.config as CoreDateConfig,
        invocation.input as CoreDateInput,
      ),
    ),
});
