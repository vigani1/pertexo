import {
  DATA_TABLE_LIMITS,
  DataTableError,
  type DataTableValues,
} from '@pertexo/node-sdk';
import { canonicalJson, utf8ByteLength } from '@pertexo/workflow-model';

import type { DataTableDefinition } from '../contract.js';

/** What a row's unique key is stored as, so equal values clash however they're written. */
export function keyValue(
  table: DataTableDefinition,
  values: DataTableValues,
): string | null {
  if (table.keyColumn === null) return null;
  const key = canonicalJson(values[table.keyColumn]);
  if (utf8ByteLength(key) > DATA_TABLE_LIMITS.keyBytes)
    throw new DataTableError(
      'invalid_values',
      'A unique key must fit 1 KiB. Use a shorter identifier.',
    );
  return key;
}

/** Names the clash, since the person writing the row sent this key. */
export function keyConflictMessage(
  keyColumn: string,
  values: DataTableValues,
): string {
  const key = values[keyColumn];
  const shown =
    typeof key === 'string'
      ? `“${key.length > 64 ? `${key.slice(0, 63)}…` : key}”`
      : JSON.stringify(key);
  return `A row with ${keyColumn} ${shown} already exists.`;
}
