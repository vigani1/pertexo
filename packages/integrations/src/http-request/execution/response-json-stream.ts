interface JsonStrings {
  inside: boolean;
  escaped: boolean;
  parts: string[];
}

/** Decode each JSON string before redaction; escape spelling and chunking carry no authority. */
export async function* redactResponseJsonStream(
  body: AsyncIterable<Uint8Array>,
  redact: (text: string) => string,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  const state: JsonStrings = { inside: false, escaped: false, parts: [] };
  let received = 0;
  let emitted = 0;
  const project = (text: string): Uint8Array => {
    const bytes = encoder.encode(redactJsonStrings(text, state, redact));
    emitted += bytes.byteLength;
    if (emitted > maxBytes)
      throw new Error('HTTP response exceeds its byte limit');
    return bytes;
  };
  for await (const chunk of body) {
    received += chunk.byteLength;
    // A single unterminated string must never accumulate beyond the response bound.
    if (received > maxBytes)
      throw new Error('HTTP response exceeds its byte limit');
    const bytes = project(decoder.decode(chunk, { stream: true }));
    if (bytes.byteLength > 0) yield bytes;
  }
  const tail = project(decoder.decode());
  if (state.inside)
    throw new Error('HTTP response has an incomplete JSON string');
  if (tail.byteLength > 0) yield tail;
}

function redactJsonStrings(
  text: string,
  state: JsonStrings,
  redact: (text: string) => string,
): string {
  const output: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (!state.inside) {
      if (character !== '"') continue;
      output.push(text.slice(start, index));
      start = index;
      state.inside = true;
    } else if (state.escaped) state.escaped = false;
    else if (character === '\\') state.escaped = true;
    else if (character === '"') {
      state.parts.push(text.slice(start, index + 1));
      const original = state.parts.join('');
      const decoded = JSON.parse(original) as string;
      const redacted = redact(decoded);
      output.push(redacted === decoded ? original : JSON.stringify(redacted));
      state.parts = [];
      state.inside = false;
      start = index + 1;
    }
  }
  const remaining = text.slice(start);
  if (state.inside) state.parts.push(remaining);
  else output.push(remaining);
  return output.join('');
}
