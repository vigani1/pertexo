import { expect, it } from 'vitest';
import { boundedRedactedBody } from '../../src/outbound-http/stream-redaction.js';

it.each([1, 32, 100])(
  'drains a 10 MiB JSON response with %i credentials including a long value',
  async (count) => {
    const sensitiveValues = Array.from({ length: count }, (_, index) =>
      index === 0
        ? 'long-private-' + 'q'.repeat(7_990)
        : `private-credential-${String(index).padStart(3, '0')}`,
    );
    const record = JSON.stringify({
      name: 'public customer record',
      description: 'plain response values',
      count: 12,
    });
    const source = Buffer.from(
      '[' +
        (record + ',').repeat(
          Math.floor(10_485_760 / (record.length + 1)) - 1,
        ) +
        record +
        ']',
    );
    const started = performance.now();
    const retained: Buffer[] = [];
    for await (const chunk of boundedRedactedBody(
      (async function* () {
        await Promise.resolve();
        for (let offset = 0; offset < source.length; offset += 65_536)
          yield Buffer.from(source.subarray(offset, offset + 65_536));
      })(),
      {
        limit: 10_485_760,
        sensitiveValues,
        signal: new AbortController().signal,
        deadline: started + 30_000,
      },
    ))
      retained.push(Buffer.from(chunk));
    expect(Buffer.concat(retained).equals(source)).toBe(true);
    expect(performance.now() - started).toBeLessThan(
      count === 32 ? 1_000 : 2_000,
    );
  },
);
