export const SSE_LIMITS = Object.freeze({
  frameBytes: 64 * 1_024,
  retainedBytes: 128 * 1_024,
});

export interface SseMessage {
  id: string;
  event: string;
  data: string;
}

export class SseProtocolError extends Error {
  public override readonly name = 'SseProtocolError';
}

export async function* decodeSseMessages(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let retained = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      try {
        retained += decoder.decode(chunk.value, { stream: true });
      } catch (cause) {
        throw new SseProtocolError(
          'The event stream contained invalid UTF-8.',
          {
            cause,
          },
        );
      }
      for (;;) {
        const boundary = findFrameBoundary(retained);
        if (boundary === null) break;
        const frame = retained.slice(0, boundary.index);
        retained = retained.slice(boundary.end);
        if (encoder.encode(frame).byteLength > SSE_LIMITS.frameBytes)
          throw new SseProtocolError(
            'An event stream frame exceeded its limit.',
          );
        const message = parseFrame(frame);
        if (message !== null) yield message;
      }
      if (encoder.encode(retained).byteLength > SSE_LIMITS.retainedBytes)
        throw new SseProtocolError(
          'The event stream buffer exceeded its limit.',
        );
    }
    try {
      retained += decoder.decode();
    } catch (cause) {
      throw new SseProtocolError('The event stream ended with invalid UTF-8.', {
        cause,
      });
    }
    if (retained.trim() !== '')
      throw new SseProtocolError(
        'The event stream ended with a partial frame.',
      );
  } finally {
    reader.releaseLock();
  }
}

function findFrameBoundary(
  value: string,
): Readonly<{ index: number; end: number }> | null {
  const match = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/u.exec(value);
  return match === null
    ? null
    : { index: match.index, end: match.index + match[0].length };
}

function parseFrame(frame: string): SseMessage | null {
  let id = '';
  let event = '';
  const data: string[] = [];
  for (const line of frame.split(/\r\n|\n|\r/u)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const rawValue = colon < 0 ? '' : line.slice(colon + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'id') {
      if (value.includes('\0'))
        throw new SseProtocolError('An event stream ID was invalid.');
      id = value;
    } else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join('\n') };
}
