import { expect, it } from 'vitest';
import { boundedRedactedBody } from '../../src/outbound-http/stream-redaction.js';

it.each([1, 2, 3, 4])(
  'masks %i JSON-string layers across a sanitizer buffer boundary',
  async (layers) => {
    const secret = 'credential-"\\-é-private';
    let echo = secret;
    for (let layer = 1; layer < layers; layer += 1)
      echo = JSON.stringify({ value: echo }).replaceAll('é', '\\u00e9');
    const encoded = JSON.stringify(echo).replaceAll('é', '\\u00e9');
    for (const offset of [
      1,
      Math.floor(encoded.length / 2),
      encoded.length - 1,
    ]) {
      const body = Buffer.from(' '.repeat(65_536 - offset) + encoded);
      const retained: Buffer[] = [];
      for await (const chunk of boundedRedactedBody(
        (async function* () {
          await Promise.resolve();
          for (const byte of body) yield Uint8Array.of(byte);
        })(),
        {
          limit: 100_000,
          sensitiveValues: [secret],
          signal: new AbortController().signal,
          deadline: performance.now() + 10_000,
        },
      ))
        retained.push(Buffer.from(chunk));
      let decoded: unknown = JSON.parse(Buffer.concat(retained).toString());
      for (let layer = 1; layer < layers; layer += 1) {
        const value: unknown = JSON.parse(String(decoded));
        if (value === null || typeof value !== 'object')
          throw new Error('Expected nested response');
        decoded = Reflect.get(value, 'value');
      }
      expect(decoded).toBe('[Redacted]');
    }
  },
);

it.each([
  { charset: 'unknown-charset', bytes: Buffer.from('credential') },
  { charset: 'utf-16le', bytes: Buffer.from([0xff]) },
])(
  'refuses undecodable declared $charset text before retaining it',
  async ({ charset, bytes }) => {
    const retained: Uint8Array[] = [];
    const operation = async () => {
      for await (const chunk of boundedRedactedBody(
        (async function* () {
          await Promise.resolve();
          yield bytes;
        })(),
        {
          limit: 100,
          charset,
          sensitiveValues: ['credential'],
          signal: new AbortController().signal,
          deadline: performance.now() + 1_000,
        },
      ))
        retained.push(chunk);
    };
    await expect(operation()).rejects.toMatchObject({
      code: 'response_encoding_rejected',
    });
    expect(retained).toEqual([]);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  },
);

it('preserves transport failures rather than classifying them as charset refusals', async () => {
  const retained: Uint8Array[] = [];
  const operation = async () => {
    for await (const chunk of boundedRedactedBody(
      (async function* () {
        await Promise.resolve();
        yield Buffer.from('partial response');
        throw new TypeError('synthetic transport failure');
      })(),
      {
        limit: 100,
        charset: 'utf-16le',
        sensitiveValues: [],
        signal: new AbortController().signal,
        deadline: performance.now() + 1_000,
      },
    ))
      retained.push(chunk);
  };
  await expect(operation()).rejects.toMatchObject({ code: 'network_failed' });
  expect(retained).toEqual([]);
});
