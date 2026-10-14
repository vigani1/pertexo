import type { CoreBatchConfig, CoreBatchInput } from '../batch/validation.js';
import { checkCanceled } from './selection.js';
import type { JsonValue } from '@pertexo/workflow-model';
export function batchItems(
  config: CoreBatchConfig,
  input: CoreBatchInput,
  signal: AbortSignal,
) {
  const batches: JsonValue[][] = [];
  for (let start = 0; start < input.items.length; start += config.size) {
    checkCanceled(signal);
    batches.push(input.items.slice(start, start + config.size));
  }
  checkCanceled(signal);
  return {
    batches,
    inputCount: input.items.length,
    batchCount: batches.length,
  };
}
