/** Byte offsets retain the original spelling; only a matching credential is replaced. */
export type DecodedBodyView = Readonly<{
  bytes: Buffer;
  sourceStart(position: number): number;
  sourceEnd(position: number): number;
  sourceBoundary(position: number): number;
}>;

type EscapeSpan = Readonly<{
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
}>;

/** JSON escapes can appear in any textual response, including malformed JSON and plain text. */
export function decodedBodyView(source: Buffer): DecodedBodyView | undefined {
  if (!source.includes(92)) return undefined;
  const text = source.toString('latin1');
  const escapes = /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/gu;
  const spans: EscapeSpan[] = [];
  const parts: Buffer[] = [];
  const decodedParts: Buffer[] = [];
  let sourceOffset = 0;
  let decodedOffset = 0;
  for (
    let match = escapes.exec(text);
    match !== null;
    match = escapes.exec(text)
  ) {
    const before = source.subarray(sourceOffset, match.index);
    parts.push(before);
    decodedOffset += before.length;
    let escape = match[0];
    // A surrogate pair is one decoded code point and one original byte range.
    if (
      isHighSurrogate(escape) &&
      /^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/u.test(
        text.slice(escapes.lastIndex, escapes.lastIndex + 6),
      )
    ) {
      escape += text.slice(escapes.lastIndex, escapes.lastIndex + 6);
      escapes.lastIndex += 6;
    }
    const decoded = Buffer.from(
      JSON.parse('"' + escape + '"') as string,
      'utf8',
    );
    decodedParts.push(decoded);
    parts.push(decoded);
    spans.push({
      start: decodedOffset,
      end: decodedOffset + decoded.length,
      sourceStart: match.index,
      sourceEnd: escapes.lastIndex,
    });
    decodedOffset += decoded.length;
    sourceOffset = escapes.lastIndex;
  }
  if (spans.length === 0) return undefined;
  parts.push(source.subarray(sourceOffset));
  const bytes = Buffer.concat(parts);
  for (const part of decodedParts) part.fill(0);
  return {
    bytes,
    sourceStart: (position) => sourcePosition(spans, position, false),
    sourceEnd: (position) => sourcePosition(spans, position - 1, true),
    sourceBoundary: (position) => {
      const span = lastSpanBefore(spans, position, 'sourceStart');
      return span !== undefined && position < span.sourceEnd
        ? span.sourceStart
        : position;
    },
  };
}

function isHighSurrogate(escape: string): boolean {
  return /^\\u[dD][89abAB][0-9a-fA-F]{2}$/u.test(escape);
}

function sourcePosition(
  spans: readonly EscapeSpan[],
  position: number,
  end: boolean,
): number {
  const span = lastSpanBefore(spans, position, 'start');
  if (span === undefined) return position + Number(end);
  if (position < span.end) return end ? span.sourceEnd : span.sourceStart;
  return position + span.sourceEnd - span.end + Number(end);
}

function lastSpanBefore(
  spans: readonly EscapeSpan[],
  position: number,
  field: 'start' | 'sourceStart',
): EscapeSpan | undefined {
  let low = 0,
    high = spans.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const span = spans[middle];
    if (span !== undefined && span[field] <= position) low = middle + 1;
    else high = middle;
  }
  return spans[low - 1];
}
