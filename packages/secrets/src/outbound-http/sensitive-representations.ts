import { isSupportedHttpFieldValue } from '@pertexo/contracts';

/** Common service echo representations, bounded by the admitted credential size. */
export function sensitiveRepresentations(
  values: readonly string[],
): readonly string[] {
  const representations = new Set<string>();
  for (const value of values) {
    const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/iu.exec(value)?.[1];
    const originals =
      basic === undefined
        ? [value]
        : [value, basic, Buffer.from(basic, 'base64').toString('utf8')];
    if (basic !== undefined) {
      const decoded = Buffer.from(basic, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) originals.push(decoded.slice(separator + 1));
    }
    for (const original of originals) {
      if (original.length === 0) continue;
      const text = original.toWellFormed();
      const bytes = Buffer.from(original, 'utf8');
      const percent = [...bytes]
        .map((byte) => '%' + byte.toString(16).padStart(2, '0'))
        .join('');
      const unicode = original
        .split('')
        .map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
        .join('');
      const forms = [
        original,
        JSON.stringify(original).slice(1, -1),
        unicode,
        unicode.replace(
          /\\u([a-f0-9]{4})/gu,
          (_match, hex: string) => '\\u' + hex.toUpperCase(),
        ),
        encodeURI(text),
        encodeURIComponent(text),
        new URLSearchParams({ value: text }).toString().slice(6),
        percent,
        percent.toUpperCase(),
        bytes.toString('base64'),
        bytes.toString('base64url'),
      ];
      if (isSupportedHttpFieldValue(original))
        forms.push(Buffer.from(original, 'latin1').toString('base64'));
      for (const form of forms) representations.add(form);
    }
  }
  return [...representations].sort((left, right) => right.length - left.length);
}

/** Prepared once for a response; wire bytes and decoded JSON escapes use these same patterns. */
export function prepareSensitiveBytePatterns(
  values: readonly string[],
): readonly Uint8Array[] {
  return sensitiveRepresentations(values)
    .flatMap((value) => {
      const text = Buffer.from(value, 'utf8');
      if (!isSupportedHttpFieldValue(value)) return [text];
      // Node sends header values as Latin-1; a service may echo decoded UTF-8 or the wire bytes.
      const wire = Buffer.from(value, 'latin1');
      return text.equals(wire) ? [text] : [text, wire];
    })
    .sort((left, right) => right.byteLength - left.byteLength);
}
