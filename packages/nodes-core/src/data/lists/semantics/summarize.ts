import {
  canonicalJson,
  parseJsonPath,
  resolveJsonPath,
} from '@pertexo/workflow-model';
import type {
  CoreSummarizeConfig,
  CoreSummarizeInput,
} from '../summarize/validation.js';
import { invalidInput, projectItems } from './selection.js';

interface Group {
  key: string | number | boolean | null;
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
}
function groupFor(key: Group['key']): Group {
  return { key, count: 0, sum: 0, min: null, max: null };
}
function checkNumber(value: number): void {
  if (
    !Number.isFinite(value) ||
    (Number.isInteger(value) && !Number.isSafeInteger(value))
  )
    invalidInput(
      'Summary numbers and arithmetic must remain finite and safe integers when integral',
    );
}
export function summarizeItems(
  config: CoreSummarizeConfig,
  input: CoreSummarizeInput,
  signal: AbortSignal,
) {
  const groups = new Map<string, Group>();
  // Registry config validation guarantees that a present path has valid segments.
  const groupPath =
    config.groupBy === undefined
      ? undefined
      : (parseJsonPath(config.groupBy) as readonly (string | number)[]);
  const grouped = groupPath !== undefined;
  if (!grouped) groups.set('null', groupFor(null));
  let skippedCount = 0;
  for (const { item, value } of projectItems(
    input.items,
    config.valuePath,
    signal,
  )) {
    const groupValue =
      groupPath === undefined
        ? { kind: 'value' as const, value: null }
        : resolveJsonPath(item, groupPath);
    const key = groupValue.kind === 'value' ? groupValue.value : undefined;
    if (value !== undefined && value !== null && typeof value !== 'number')
      return invalidInput('Summary values must be numbers');
    if (key !== undefined && key !== null && typeof key === 'object')
      return invalidInput('Summary group keys must be scalar values');
    if (value === undefined || value === null || key === undefined) {
      if (config.missing === 'error')
        return invalidInput('Summary numeric value or group key is missing');
      skippedCount++;
      continue;
    }
    checkNumber(value);
    const identity = canonicalJson(key);
    let group = groups.get(identity);
    if (group === undefined) {
      group = groupFor(key);
      groups.set(identity, group);
    }
    const sum = group.sum + value;
    checkNumber(sum);
    group.sum = sum;
    group.count++;
    group.min = group.min === null ? value : Math.min(group.min, value);
    group.max = group.max === null ? value : Math.max(group.max, value);
  }
  return {
    groups: [...groups.values()].map((group) => ({
      ...group,
      average: group.count === 0 ? null : group.sum / group.count,
    })),
    inputCount: input.items.length,
    skippedCount,
  };
}
