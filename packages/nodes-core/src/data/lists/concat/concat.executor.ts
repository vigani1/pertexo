import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_CONCAT_EXECUTOR } from './concat.definition.js';
import type { CoreConcatConfig, CoreConcatInput } from './concat.schemas.js';
import { concatenateItems } from '../semantics/concat.js';
export const coreConcatExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_CONCAT_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(
      concatenateItems(
        invocation.config as CoreConcatConfig,
        invocation.input as CoreConcatInput,
        invocation.signal,
      ),
    ),
});
