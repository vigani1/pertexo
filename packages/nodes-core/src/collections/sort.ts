import type { JsonValue } from '@pertexo/workflow-model';
import type { CoreSortConfig, CoreSortInput } from '../sort/validation.js';
import { checkCanceled, invalidInput, projectItems } from './selection.js';

interface SortEntry {
  item: JsonValue;
  key: string | number | null;
  ordinal: number;
}
export function sortItems(
  config: CoreSortConfig,
  input: CoreSortInput,
  signal: AbortSignal,
) {
  const entries: SortEntry[] = [];
  for (const { item, value, ordinal } of projectItems(
    input.items,
    config.path,
    signal,
  )) {
    if (value === undefined || value === null)
      entries.push({ item, key: null, ordinal });
    else if (
      (config.valueType === 'number' && typeof value === 'number') ||
      (config.valueType === 'text' && typeof value === 'string')
    )
      entries.push({ item, key: value, ordinal });
    else return invalidInput('Sort keys must match the configured value type');
  }
  const direction = config.direction === 'ascending' ? 1 : -1;
  const missing = config.missing === 'first' ? -1 : 1;
  entries.sort((left, right) => {
    if (left.key === null || right.key === null)
      return left.key === right.key
        ? left.ordinal - right.ordinal
        : left.key === null
          ? missing
          : -missing;
    const comparison = left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    return comparison === 0
      ? left.ordinal - right.ordinal
      : direction * comparison;
  });
  checkCanceled(signal);
  return {
    items: entries.map((entry) => entry.item),
    inputCount: input.items.length,
  };
}
