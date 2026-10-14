import type { CoreTakeConfig, CoreTakeInput } from '../take/validation.js';
import { checkCanceled } from './selection.js';
export function takeItems(
  config: CoreTakeConfig,
  input: CoreTakeInput,
  signal: AbortSignal,
) {
  checkCanceled(signal);
  const items = input.items.slice(0, config.count);
  return {
    items,
    inputCount: input.items.length,
    removedCount: input.items.length - items.length,
  };
}
