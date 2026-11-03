import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_DATE_EXECUTOR } from './date.definition.js';
import type { CoreDateConfig, CoreDateInput } from './date.schemas.js';
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
