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
