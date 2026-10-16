import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readCodeFrame, writeCodeFrame } from '../../src/server.js';

describe('bounded Code frames', () => {
  it('decodes split UTF-8 and pauses after one frame', async () => {
    const stream = new PassThrough();
    const result = readCodeFrame(stream, 128, AbortSignal.timeout(1000));
    const wire = Buffer.from('{"text":"é"}\n');
    const split = wire.indexOf(Buffer.from('é')) + 1;
    stream.write(wire.subarray(0, split));
    stream.write(wire.subarray(split));
    expect(await result).toEqual({ text: 'é' });
    expect(stream.isPaused()).toBe(true);
    stream.destroy();
  });
  it.each([
    [Buffer.from('123456789\n'), 5],
    [Buffer.from('true\nfalse\n'), 128],
    [Buffer.from('{broken}\n'), 128],
    [Buffer.from([34, 255, 34, 10]), 128],
    [Buffer.from('true'), 128],
  ] as const)(
    'refuses oversized, trailing, malformed, invalid UTF-8 or truncated data',
    async (bytes, maximum) => {
      const stream = new PassThrough();
      const result = readCodeFrame(stream, maximum, AbortSignal.timeout(1000));
      stream.end(bytes);
      await expect(result).rejects.toThrow('Code protocol');
      stream.destroy();
    },
  );
  it('cleans up an aborted read and transports trusted writes', async () => {
    const stream = new PassThrough();
    const canceled = new AbortController();
    const first = readCodeFrame(stream, 128, canceled.signal);
    canceled.abort();
    await expect(first).rejects.toThrow('aborted');
    const next = readCodeFrame(stream, 128, AbortSignal.timeout(1000));
    await writeCodeFrame(stream, { kind: 'ready' });
    expect(await next).toEqual({ kind: 'ready' });
    stream.destroy();
  });
});
