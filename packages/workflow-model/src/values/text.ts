type ByteMeasurementOptions = Readonly<{ stopAfterBytes?: number }>;

// Browser builds have no Buffer; keep the Node fast path behind this owner.
const host: {
  Buffer?: { byteLength: (value: string, encoding: 'utf8') => number };
} = globalThis;
const nativeUtf8ByteLength = host.Buffer?.byteLength;

/** Replacement bytes match UTF-8 encoding of lone surrogates on every host.
 * A finite budget returns at the first overflow, which may be a partial size.
 */
export function utf8ByteLength(
  value: string,
  options: ByteMeasurementOptions = {},
): number {
  const maximum = options.stopAfterBytes ?? Infinity;
  if (nativeUtf8ByteLength !== undefined && maximum === Infinity)
    return nativeUtf8ByteLength(value, 'utf8');
  let bytes = 0;
  for (const character of value) {
    bytes += scalarUtf8Bytes(character);
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/**
 * Drops control and format characters from a name people will read. Format
 * characters include bidi overrides, which can show `report\u202Efdp.txt` as
 * `reporttxt.pdf`.
 */
export function withoutHiddenCharacters(value: string): string {
  return value.replace(HIDDEN_CHARACTERS, '');
}

export function isWellFormed(value: string): boolean {
  return value.isWellFormed();
}

const shortJsonEscapes = new Set(['"', '\\', '\b', '\f', '\n', '\r', '\t']);

// JSON text: a string's two quotes, a two-byte escape (\n), a six-byte one
// (\u0001) for other control characters and lone surrogates.
const JSON_STRING_ENCODING = Object.freeze({
  quoteBytes: 2,
  shortEscapeBytes: 2,
  lastControlCode: 0x1f,
  unicodeEscapeBytes: 6,
});
// UTF-8 widths by code point; a surrogate pair is two UTF-16 units.
const UTF8_ENCODING = Object.freeze({
  oneByteLast: 0x7f,
  twoByteLast: 0x7ff,
  twoBytes: 2,
  threeBytes: 3,
  fourBytes: 4,
  surrogatePairUnits: 2,
});

/** Includes JSON's quotes and escapes, retaining lone surrogates as escapes:
 * this measures what JSON writes for any string. node-sdk's
 * storedExecutionJsonStringBytes refuses lone surrogates instead, because
 * stored execution text must be well-formed; the two differ on purpose.
 * Stop on overflow without allocating a serialized string or UTF-8 buffer.
 */
export function jsonStringByteLength(
  value: string,
  options: ByteMeasurementOptions = {},
): number {
  const maximum = options.stopAfterBytes ?? Infinity;
  const encoding = JSON_STRING_ENCODING;
  let bytes = encoding.quoteBytes;
  if (bytes > maximum) return bytes;
  for (const character of value) {
    if (shortJsonEscapes.has(character)) bytes += encoding.shortEscapeBytes;
    else if (
      character.charCodeAt(0) <= encoding.lastControlCode ||
      !isWellFormed(character)
    )
      bytes += encoding.unicodeEscapeBytes;
    else bytes += scalarUtf8Bytes(character);
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

function scalarUtf8Bytes(character: string): number {
  if (character.length === UTF8_ENCODING.surrogatePairUnits)
    return UTF8_ENCODING.fourBytes;
  const code = character.charCodeAt(0);
  if (code <= UTF8_ENCODING.oneByteLast) return 1;
  if (code <= UTF8_ENCODING.twoByteLast) return UTF8_ENCODING.twoBytes;
  return UTF8_ENCODING.threeBytes;
}
