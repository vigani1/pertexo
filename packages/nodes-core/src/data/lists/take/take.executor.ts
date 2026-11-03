import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_TAKE_EXECUTOR } from './take.definition.js';
import type { CoreTakeConfig, CoreTakeInput } from './take.schemas.js';
import { takeItems } from '../semantics/take.js';
export const coreTakeExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_TAKE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(
      takeItems(
        invocation.config as CoreTakeConfig,
        invocation.input as CoreTakeInput,
        invocation.signal,
      ),
    ),
});
