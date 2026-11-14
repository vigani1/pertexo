import { StoredExecutionValueInvalidError } from './stored-json.errors.js';
export const STORED_EXECUTION_VALUE_LIMITS = Object.freeze({
  inlineBytes: 262_144,
  depth: 64,
  members: 10_000,
});

// JSON text: a string's two quotes, a two-byte escape (\n), a six-byte one
// (\u0001) for other control characters. Stored text is well-formed, so a
// high surrogate always starts a four-byte pair.
const JSON_STRING_ENCODING = Object.freeze({
  quoteBytes: 2,
  shortEscapeBytes: 2,
  lastControlCode: 0x1f,
  unicodeEscapeBytes: 6,
});
const SHORT_ESCAPE_CODES: ReadonlySet<number> = new Set([
  0x22, 0x5c, 0x08, 0x0c, 0x0a, 0x0d, 0x09,
]);
const UTF8_ENCODING = Object.freeze({
  oneByteLast: 0x7f,
  twoByteLast: 0x7ff,
  highSurrogateFirst: 0xd800,
  highSurrogateLast: 0xdbff,
  twoBytes: 2,
  threeBytes: 3,
  fourBytes: 4,
});

function invalid(): never {
  throw new StoredExecutionValueInvalidError();
}

export function storedExecutionJsonStringBytes(value: string): number {
  // JSON needs at least its quotes plus one byte per UTF-16 code unit.
  // Bound the native Unicode check and keep the SDK graph-independent.
  if (
    value.length >
      STORED_EXECUTION_VALUE_LIMITS.inlineBytes -
        JSON_STRING_ENCODING.quoteBytes ||
    !value.isWellFormed()
  )
    invalid();
  let bytes = JSON_STRING_ENCODING.quoteBytes;
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > STORED_EXECUTION_VALUE_LIMITS.inlineBytes) invalid();
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) invalid();
    if (SHORT_ESCAPE_CODES.has(code))
      add(JSON_STRING_ENCODING.shortEscapeBytes);
    else if (code <= JSON_STRING_ENCODING.lastControlCode)
      add(JSON_STRING_ENCODING.unicodeEscapeBytes);
    else {
      const width = unicodeWidth(code);
      add(width);
      if (width === UTF8_ENCODING.fourBytes) index += 1;
    }
  }
  return bytes;
}

function unicodeWidth(code: number): number {
  if (code <= UTF8_ENCODING.oneByteLast) return 1;
  if (code <= UTF8_ENCODING.twoByteLast) return UTF8_ENCODING.twoBytes;
  if (
    code >= UTF8_ENCODING.highSurrogateFirst &&
    code <= UTF8_ENCODING.highSurrogateLast
  )
    return UTF8_ENCODING.fourBytes;
  return UTF8_ENCODING.threeBytes;
}
