import { StoredExecutionValueInvalidError } from './stored-json.errors.js';
export const STORED_EXECUTION_VALUE_LIMITS = Object.freeze({
  inlineBytes: 262_144,
  depth: 64,
  members: 10_000,
});

// JSON text: a string's two quotes, a two-byte escape (\n), a six-byte one
// (\u0001) for other control characters. Stored text is well-formed, so a
// high surrogate always starts a four-byte pair.
const JSON_QUOTE_BYTES = 2;
const JSON_SHORT_ESCAPE_BYTES = 2;
const JSON_LAST_CONTROL_CODE = 0x1f;
const JSON_UNICODE_ESCAPE_BYTES = 6;
const SHORT_ESCAPE_CODES: ReadonlySet<number> = new Set([
  0x22, 0x5c, 0x08, 0x0c, 0x0a, 0x0d, 0x09,
]);
const UTF8_ONE_BYTE_LAST = 0x7f;
const UTF8_TWO_BYTE_LAST = 0x7ff;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const UTF8_TWO_BYTES = 2;
const UTF8_THREE_BYTES = 3;
const UTF8_FOUR_BYTES = 4;

function invalid(): never {
  throw new StoredExecutionValueInvalidError();
}

export function storedExecutionJsonStringBytes(value: string): number {
  // JSON needs at least its quotes plus one byte per UTF-16 code unit.
  // Bound the native Unicode check and keep the SDK graph-independent.
  if (
    value.length >
      STORED_EXECUTION_VALUE_LIMITS.inlineBytes - JSON_QUOTE_BYTES ||
    !value.isWellFormed()
  )
    invalid();
  let bytes = JSON_QUOTE_BYTES;
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > STORED_EXECUTION_VALUE_LIMITS.inlineBytes) invalid();
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) invalid();
    if (SHORT_ESCAPE_CODES.has(code)) add(JSON_SHORT_ESCAPE_BYTES);
    else if (code <= JSON_LAST_CONTROL_CODE) add(JSON_UNICODE_ESCAPE_BYTES);
    else {
      const width = unicodeWidth(code);
      add(width);
      if (width === UTF8_FOUR_BYTES) index += 1;
    }
  }
  return bytes;
}

function unicodeWidth(code: number): number {
  if (code <= UTF8_ONE_BYTE_LAST) return 1;
  if (code <= UTF8_TWO_BYTE_LAST) return UTF8_TWO_BYTES;
  if (code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST)
    return UTF8_FOUR_BYTES;
  return UTF8_THREE_BYTES;
}
