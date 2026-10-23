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
    else {
      const matchesValueType =
        (config.valueType === 'number' && typeof value === 'number') ||
        (config.valueType === 'text' && typeof value === 'string');
      if (!matchesValueType)
        return invalidInput('Sort keys must match the configured value type');
      entries.push({ item, key: value, ordinal });
    }
  }
  const direction = config.direction === 'ascending' ? 1 : -1;
  const missing = config.missing === 'first' ? -1 : 1;
  entries.sort((left, right) => {
    if (left.key === null || right.key === null) {
      if (left.key === right.key) return left.ordinal - right.ordinal;
      return left.key === null ? missing : -missing;
    }
    const comparison = compareKeys(left.key, right.key);
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

function compareKeys(left: string | number, right: string | number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
