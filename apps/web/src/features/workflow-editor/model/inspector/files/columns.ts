import { isRecord } from '@pertexo/workflow-model';
import type { FieldParseResult } from '../draft';

export type ColumnLimits = Readonly<{ count: number; characters: number }>;
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

/**
 * Adds a typed name, or each line of pasted text, after the chosen columns.
 * Names keep their exact spelling: the file's header uses them as written.
 */
export function addFileColumns(
  columns: readonly string[],
  text: string,
  limits: ColumnLimits,
): FieldParseResult<readonly string[]> {
  const added = text.split(/\r?\n/u).filter((name) => name !== '');
  if (added.length === 0)
    return { ok: false, error: 'Type a field name to add.' };
  if (columns.length + added.length > limits.count)
    return {
      ok: false,
      error: `Choose up to ${String(limits.count)} columns.`,
    };
  if (
    added.some((name) => name.trim() === '' || name.length > limits.characters)
  )
    return {
      ok: false,
      error: `Use nonblank names up to ${String(limits.characters)} characters.`,
    };
  const next = [...columns, ...added];
  if (new Set(next).size !== next.length)
    return { ok: false, error: 'Choose each column once.' };
  return { ok: true, value: next };
}

export function moveFileColumn(
  columns: readonly string[],
  index: number,
  by: -1 | 1,
): readonly string[] {
  const target = index + by;
  const moved = columns[index];
  if (moved === undefined || target < 0 || target >= columns.length)
    return columns;
  const next = columns.filter((_, position) => position !== index);
  next.splice(target, 0, moved);
  return next;
}
