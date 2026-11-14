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
const JSON_QUOTE_BYTES = 2;
const JSON_SHORT_ESCAPE_BYTES = 2;
const JSON_LAST_CONTROL_CODE = 0x1f;
const JSON_UNICODE_ESCAPE_BYTES = 6;
// UTF-8 widths by code point; a surrogate pair is two UTF-16 units.
const UTF8_ONE_BYTE_LAST = 0x7f;
const UTF8_TWO_BYTE_LAST = 0x7ff;
const UTF8_TWO_BYTES = 2;
const UTF8_THREE_BYTES = 3;
const UTF8_FOUR_BYTES = 4;
const SURROGATE_PAIR_UNITS = 2;

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
  let bytes = JSON_QUOTE_BYTES;
  if (bytes > maximum) return bytes;
  for (const character of value) {
    if (shortJsonEscapes.has(character)) bytes += JSON_SHORT_ESCAPE_BYTES;
    else if (
      character.charCodeAt(0) <= JSON_LAST_CONTROL_CODE ||
      !isWellFormed(character)
    )
      bytes += JSON_UNICODE_ESCAPE_BYTES;
    else bytes += scalarUtf8Bytes(character);
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

function scalarUtf8Bytes(character: string): number {
  if (character.length === SURROGATE_PAIR_UNITS) return UTF8_FOUR_BYTES;
  const code = character.charCodeAt(0);
  if (code <= UTF8_ONE_BYTE_LAST) return 1;
  if (code <= UTF8_TWO_BYTE_LAST) return UTF8_TWO_BYTES;
  return UTF8_THREE_BYTES;
}
