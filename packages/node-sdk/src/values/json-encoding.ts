import type { JsonValue } from '../execution/node-execution.types.js';

type Frame = Readonly<{ value: JsonValue }> | string;

/** Serialize admitted own-data JSON without calling container toJSON methods. */
export function encodeJson(value: JsonValue): string {
  return encode(value);
}

/**
 * Keys in plain code-unit order, which preserves existing outbox checksums
 * and portable manifest digests. Array order, scalar escaping and number
 * representation are the same as `encodeJson`. (Workflow values get their
 * ECMAScript integer-key order from workflow-model's `canonicalizeJson`.)
 */
export function encodeCanonicalJson(value: JsonValue): string {
  return encode(value, true);
}

function encode(value: JsonValue, sortKeys = false): string {
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
    const keys = Object.keys(record);
    if (sortKeys) keys.sort();
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
