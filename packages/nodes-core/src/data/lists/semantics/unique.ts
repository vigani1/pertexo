import { canonicalJson, type JsonValue } from '@pertexo/workflow-model';
import type {
  CoreUniqueConfig,
  CoreUniqueInput,
} from '../unique/validation.js';
import { invalidInput, projectItems } from './selection.js';

export function uniqueItems(
  config: CoreUniqueConfig,
  input: CoreUniqueInput,
  signal: AbortSignal,
) {
  const seen = new Set<string>(),
    items: JsonValue[] = [];
  let skippedCount = 0,
    duplicateCount = 0;
  for (const { item, value } of projectItems(
    input.items,
    config.path,
    signal,
  )) {
    if (value === undefined) {
      if (config.missing === 'error')
        return invalidInput('Duplicate comparison key is missing');
      skippedCount++;
      continue;
    }
    const key = canonicalJson(value);
    if (seen.has(key)) duplicateCount++;
    else {
      seen.add(key);
      items.push(item);
    }
  }
  return {
    items,
    inputCount: input.items.length,
    duplicateCount,
    skippedCount,
  };
}
