import type { JsonValue } from '../execution/node-execution.types.js';

type Frame = Readonly<{ value: JsonValue }> | string;

/** Serialize admitted own-data JSON without calling container toJSON methods. */
export function encodeJson(value: JsonValue): string {
  return encode(value);
}

/**
 * ECMAScript integer-key order is the workflow value contract. Lexical order
 * preserves existing outbox checksums and portable manifest digests. Neither
 * profile changes array order, scalar escaping or number representation.
 */
export function encodeCanonicalJson(
  value: JsonValue,
  order: 'ecmascript' | 'lexical' = 'ecmascript',
): string {
  return encode(value, order);
}

function encode(value: JsonValue, order?: 'ecmascript' | 'lexical'): string {
  const frames: Frame[] = [{ value }];
  const chunks: string[] = [];
  while (frames.length > 0) {
    const frame = frames.pop();
    if (frame === undefined) break;
    if (typeof frame === 'string') {
      chunks.push(frame);
      continue;
    }
    const item = frame.value;
    if (item === null || typeof item !== 'object') {
      chunks.push(JSON.stringify(item));
      continue;
    }
    if (Array.isArray(item)) {
      const items = item as readonly JsonValue[];
      frames.push(']');
      for (let index = item.length - 1; index >= 0; index -= 1) {
        frames.push({ value: items[index] as JsonValue });
        if (index > 0) frames.push(',');
      }
      frames.push('[');
      continue;
    }
    const record = item as Readonly<Record<string, JsonValue>>;
    const keys = orderedKeys(record, order);
    frames.push('}');
    let remaining = keys.length;
    for (const key of keys.reverse()) {
      frames.push(
        { value: record[key] as JsonValue },
        ':',
        JSON.stringify(key),
      );
      remaining -= 1;
      if (remaining > 0) frames.push(',');
    }
    frames.push('{');
  }
  return chunks.join('');
}

function orderedKeys(
  value: Readonly<Record<string, JsonValue>>,
  order: 'ecmascript' | 'lexical' | undefined,
): string[] {
  const keys = Object.keys(value);
  if (order === undefined) return keys;
  keys.sort();
  if (order === 'lexical') return keys;
  const indices: string[] = [];
  const names: string[] = [];
  for (const key of keys) {
    const number = Number(key);
    if (
      Number.isInteger(number) &&
      number >= 0 &&
      number < 4_294_967_295 &&
      String(number) === key
    )
      indices.push(key);
    else names.push(key);
  }
  return [
    ...indices.sort((left, right) => Number(left) - Number(right)),
    ...names,
  ];
}
