import { utf8ByteLength } from '@pertexo/workflow-model';
import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
import {
  FileInputFailure,
  InvalidBoundedJsonError,
  canonicalizeBoundedJson,
  type JsonValue,
} from '@pertexo/node-sdk/server';
import { COLLECTION_MAX_ITEMS } from '../lists/semantics/validation.js';

export function admitFileValue(value: unknown): JsonValue {
  let admitted: JsonValue;
  try {
    admitted = canonicalizeBoundedJson(value);
  } catch (error) {
    throw new FileInputFailure({
      reason:
        error instanceof InvalidBoundedJsonError &&
        error.message === 'value is not JSON'
          ? 'json_number'
          : 'value_size',
    });
  }
  const pending = [admitted];
  while (pending.length > 0) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      if (item.length > COLLECTION_MAX_ITEMS)
        throw new FileInputFailure({ reason: 'item_count' });
      pending.push(...(item as readonly JsonValue[]));
    } else if (item !== null && typeof item === 'object')
      pending.push(...Object.values(item));
  }
  return admitted;
}

/** Inline row reads stop as soon as the rows can't fit one step value. */
export async function admitFileRows(
  records: AsyncIterable<Readonly<Record<string, JsonValue>>>,
): Promise<JsonValue> {
  const rows: JsonValue[] = [];
  let members = 0,
    bytes = 2;
  for await (const row of records) {
    if (rows.length >= COLLECTION_MAX_ITEMS)
      throw new FileInputFailure({ reason: 'item_count' });
    members += 1 + Object.keys(row).length;
    if (members > NODE_JSON_LIMITS.members)
      throw new FileInputFailure({ reason: 'value_size' });
    bytes += utf8ByteLength(JSON.stringify(row)) + (rows.length > 0 ? 1 : 0);
    if (bytes > NODE_JSON_LIMITS.bytes)
      throw new FileInputFailure({ reason: 'value_size' });
    rows.push(row);
  }
  return admitFileValue(rows);
}
