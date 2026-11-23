import { expect, it } from 'vitest';
import { readMcpReply } from '../../src/mcp/reply.js';

const result = { tools: [] };
const line = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result })}`;

it.each([
  { framing: 'CR only', chunks: [`${line}\r\r`] },
  { framing: 'split CRLF', chunks: [`${line}\r`, '\n\r'], open: true },
])(
  'reads an SSE reply with $framing line endings',
  async ({ chunks, open }) => {
    await expect(
      readMcpReply(
        {
          body: (async function* () {
            for (const chunk of chunks) yield Buffer.from(chunk);
            if (open) throw new Error('A complete reply must end consumption');
            await Promise.resolve();
          })(),
          headers: { 'content-type': 'text/event-stream' },
          status: 200,
          bodyEncoding: 'utf8',
          finalUrl: 'https://provider.example',
          redirectCount: 0,
          signal: new AbortController().signal,
        },
        2,
      ),
    ).resolves.toEqual(result);
  },
);
