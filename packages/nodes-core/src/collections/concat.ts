import type {
  CoreConcatConfig,
  CoreConcatInput,
} from '../concat/validation.js';
import { checkCanceled, invalidInput } from './selection.js';
import { COLLECTION_MAX_ITEMS } from './validation.js';
export function concatenateItems(
  _config: CoreConcatConfig,
  input: CoreConcatInput,
  signal: AbortSignal,
) {
  checkCanceled(signal);
  const count = input.items.length + input.otherItems.length;
  if (count > COLLECTION_MAX_ITEMS)
    return invalidInput('The combined lists exceed the collection limit');
  return { items: input.items.concat(input.otherItems), inputCount: count };
}
