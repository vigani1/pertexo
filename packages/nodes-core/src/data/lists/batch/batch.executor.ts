import { inlineCoreExecutor } from '../../../catalog/inline-registration.js';
import { inlineBatch } from './batch-kernel.js';
import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_BATCH_EXECUTOR } from './batch.definition.js';
import type { CoreBatchConfig, CoreBatchInput } from './batch.schemas.js';
import { batchItems } from './semantics.js';
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

export const coreBatchInlineExecutor = inlineCoreExecutor(coreBatchExecutor, {
  executeInline: inlineBatch,
});
