import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../../catalog/inline-result.js';
import type { CoreBatchConfig, CoreBatchInput } from './batch.schemas.js';
import { batchItems } from './semantics.js';

export function inlineBatch({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    batchItems(config as CoreBatchConfig, input as CoreBatchInput),
  );
}
