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

/** Includes JSON's quotes and escapes, retaining lone surrogates as escapes.
 * Stop on overflow without allocating a serialized string or UTF-8 buffer.
 */
export function jsonStringByteLength(
  value: string,
  options: ByteMeasurementOptions = {},
): number {
  const maximum = options.stopAfterBytes ?? Infinity;
  let bytes = 2;
  if (bytes > maximum) return bytes;
  for (const character of value) {
    if (shortJsonEscapes.has(character)) bytes += 2;
    else if (character.charCodeAt(0) <= 0x1f || !isWellFormed(character))
      bytes += 6;
    else bytes += scalarUtf8Bytes(character);
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

function scalarUtf8Bytes(character: string): number {
  if (character.length === 2) return 4;
  const code = character.charCodeAt(0);
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  return 3;
}
