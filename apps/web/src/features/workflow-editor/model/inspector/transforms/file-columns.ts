import { isRecord } from '@pertexo/workflow-model';
import type { FieldParseResult } from '../draft';

type ColumnLimits = Readonly<{ count: number; characters: number }>;
export function fileColumnLimits(schema: unknown): ColumnLimits | undefined {
  if (!isRecord(schema)) return undefined;
  for (const key of ['oneOf', 'anyOf']) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants as unknown[]) {
      if (!isRecord(variant) || !isRecord(variant.properties)) continue;
      const columns = variant.properties.columns;
      if (!isRecord(columns) || !isRecord(columns.items)) continue;
      if (
        typeof columns.maxItems === 'number' &&
        typeof columns.items.maxLength === 'number'
      )
        return { count: columns.maxItems, characters: columns.items.maxLength };
    }
  }
  return undefined;
}
export function parseFileColumns(
  text: string,
  limits: ColumnLimits,
): FieldParseResult<readonly string[]> {
  const columns = text === '' ? [] : text.split(/\r?\n/u);
  if (columns.length > limits.count)
    return {
      ok: false,
      error: `Choose up to ${String(limits.count)} columns.`,
    };
  if (
    columns.some(
      (name) => name.trim() === '' || name.length > limits.characters,
    )
  )
    return {
      ok: false,
      error: `Use nonblank names up to ${String(limits.characters)} characters, one per line.`,
    };
  if (new Set(columns).size !== columns.length)
    return { ok: false, error: 'Choose each column once.' };
  return { ok: true, value: columns };
}
