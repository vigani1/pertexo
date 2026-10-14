import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_BATCH_EXECUTOR } from './definition.js';
import type { CoreBatchConfig, CoreBatchInput } from './validation.js';
import { batchItems } from '../collections/batch.js';
export const coreBatchExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_BATCH_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(
      batchItems(
        invocation.config as CoreBatchConfig,
        invocation.input as CoreBatchInput,
        invocation.signal,
      ),
    ),
});
