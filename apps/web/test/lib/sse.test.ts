import { describe, expect, it } from 'vitest';
import {
  decodeSseMessages,
  SSE_LIMITS,
  SseProtocolError,
} from '../../src/lib/api/sse';

function chunks(...values: readonly Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const messages = [];
  for await (const message of decodeSseMessages(stream)) messages.push(message);
  return messages;
}

describe('bounded SSE decoder', () => {
  it('handles split UTF-8, CRLF, comments and multiline data', async () => {
    const encoded = new TextEncoder().encode(
      ': heartbeat\r\nid: 1\r\nevent: node.progress\r\ndata: {"label":"café"}\r\ndata: continued\r\n\r\n',
    );
    const split = encoded.indexOf(0xc3) + 1;
    await expect(
      collect(chunks(encoded.slice(0, split), encoded.slice(split))),
    ).resolves.toEqual([
      {
        id: '1',
        event: 'node.progress',
        data: '{"label":"café"}\ncontinued',
      },
    ]);
    await expect(
      collect(
        chunks(
          new TextEncoder().encode(
            'id: 2\nevent: run.started\r\ndata: {}\r\n\n',
          ),
        ),
      ),
    ).resolves.toEqual([{ id: '2', event: 'run.started', data: '{}' }]);
  });

  it('drains many complete frames before applying the retained-buffer bound', async () => {
    const frame = 'id: 1\nevent: node.progress\ndata: {}\n\n';
    const batch = new TextEncoder().encode(
      frame.repeat(Math.ceil(SSE_LIMITS.retainedBytes / frame.length) + 1),
    );
    await expect(collect(chunks(batch))).resolves.toHaveLength(
      Math.ceil(SSE_LIMITS.retainedBytes / frame.length) + 1,
    );
  });

  it('rejects partial, oversized and invalid UTF-8 streams', async () => {
    await expect(
      collect(chunks(new TextEncoder().encode('id: 1\ndata: {}'))),
    ).rejects.toBeInstanceOf(SseProtocolError);
    await expect(
      collect(
        chunks(
          new TextEncoder().encode(
            `id: 1\ndata: ${'x'.repeat(SSE_LIMITS.frameBytes)}\n\n`,
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(SseProtocolError);
    await expect(
      collect(chunks(new Uint8Array([0xff, 0xff]))),
    ).rejects.toBeInstanceOf(SseProtocolError);
  });
});
