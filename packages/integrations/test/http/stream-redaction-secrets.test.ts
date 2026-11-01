import { describe, expect, it, vi } from 'vitest';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  type SecureHttpRequest,
} from '../../src/server.js';
import {
  FakeResolver,
  FakeTransport,
  decoder,
  encoder,
  expectSecureFailure,
  request,
} from '../support/http-client.js';

const MARKER = '[Redacted]';
const LARGE = 10 * 1024 * 1024;

function clientFor(chunks: readonly Uint8Array[], close = vi.fn()) {
  const resolver = new FakeResolver({
    'api.example.test': [{ address: '8.8.8.8', family: 4 }],
  });
  return new SecureHttpClient(
    resolver,
    new FakeTransport(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        close,
        body: {
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
              await Promise.resolve();
              yield chunk;
            }
          },
        },
      }),
    ),
  );
}

async function redacted(
  chunks: readonly string[],
  sensitiveValues: readonly string[],
  overrides: Partial<SecureHttpRequest> = {},
): Promise<string> {
  const response = await clientFor(
    chunks.map((chunk) => encoder.encode(chunk)),
  ).execute(
    request({
      sensitiveValues,
      maxResponseBytes: LARGE,
      timeoutMillis: 30_000,
      ...overrides,
    }),
  );
  return decoder.decode(response.body);
}

function everyTwoWaySplit(body: string): readonly (readonly string[])[] {
  return Array.from({ length: body.length + 1 }, (_, at) => [
    body.slice(0, at),
    body.slice(at),
  ]);
}

function chunked(body: string, size: number): readonly string[] {
  return Array.from({ length: Math.ceil(body.length / size) }, (_, index) =>
    body.slice(index * size, (index + 1) * size),
  );
}

/** How often the event loop got to run while `work` was going. */
async function countingTurns<T>(
  work: () => Promise<T>,
): Promise<Readonly<{ turns: number; outcome: PromiseSettledResult<T> }>> {
  let turns = 0;
  let counting = true;
  const countTurn = (): void => {
    turns += 1;
    if (counting) setImmediate(countTurn);
  };
  setImmediate(countTurn);
  const [outcome] = await Promise.allSettled([work()]);
  counting = false;
  return { turns, outcome };
}

describe('a secret in a response body', () => {
  const secret = 'sk-live-0123';
  const body = `head-${secret}-mid-${secret}${secret}-tail`;
  const clean = `head-${MARKER}-mid-${MARKER}${MARKER}-tail`;

  it('is removed however the network splits the body in two', async () => {
    for (const chunks of everyTwoWaySplit(body))
      expect(await redacted(chunks, [secret]), chunks.join('|')).toBe(clean);
  });

  it('is removed when the body arrives one byte at a time', async () => {
    await expect(redacted(chunked(body, 1), [secret])).resolves.toBe(clean);
  });

  it('is removed when chunks end and start exactly on it', async () => {
    await expect(
      redacted([`a${secret}`, secret, `${secret}b`], [secret]),
    ).resolves.toBe(`a${MARKER}${MARKER}${MARKER}b`);
  });

  it('is removed when its first byte is everywhere in the body', async () => {
    const lookalike = 'aaaaab-private';
    const filler = 'a'.repeat(20_000);
    const expected = `${filler}${MARKER}${filler}${MARKER}${filler}`;
    const whole = `${filler}${lookalike}${filler}${lookalike}${filler}`;
    await expect(redacted([whole], [lookalike])).resolves.toBe(expected);
    const middle = filler.length + 3;
    await expect(
      redacted([whole.slice(0, middle), whole.slice(middle)], [lookalike]),
    ).resolves.toBe(expected);
  });

  it('is removed when a shorter secret sits inside a longer one', async () => {
    for (const chunks of everyTwoWaySplit('xabcdy'))
      expect(await redacted(chunks, ['bc', 'abcd']), chunks.join('|')).toBe(
        `x${MARKER}y`,
      );
  });

  it('is removed among the most secrets a request can carry', async () => {
    const secrets = Array.from(
      { length: 64 },
      (_, index) => `shared-prefix-${String(index).padStart(2, '0')}`,
    );
    const whole = secrets.map((value) => `<${value}>`).join('');
    const output = await redacted(chunked(whole, 7), secrets);
    expect(output).toBe(secrets.map(() => `<${MARKER}>`).join(''));
  });

  it('never survives whole next to a secret that overlaps it', async () => {
    const secrets = ['abc', 'cdefgh'];
    for (const chunks of everyTwoWaySplit('xxabcdefghyy')) {
      const output = await redacted(chunks, secrets);
      expect(output, chunks.join('|')).not.toContain('abc');
      expect(output, chunks.join('|')).not.toContain('cdefgh');
    }
  });

  /**
   * This fails today, and `stream-redaction-rules.test.ts` pins the opposite in
   * "removes the earlier secret when two overlap". The earlier secret takes the
   * shared bytes and the scan moves on, so the rest of the later one is shown.
   * It isn't new: the byte-by-byte scan before PR #580 did the same.
   */
  it.each([
    {
      shape: 'two secrets sharing a byte',
      chunks: ['xxabcdefghyy'],
      secrets: ['abc', 'cdefgh'],
    },
    {
      shape: 'two secrets sharing a byte, split on it',
      chunks: ['xxabc', 'defghyy'],
      secrets: ['abc', 'cdefgh'],
    },
    {
      shape: 'a secret overlapping itself',
      chunks: ['xxabababyy'],
      secrets: ['abab'],
    },
  ])(
    'leaves nothing of either secret when they overlap: $shape',
    async ({ chunks, secrets }) => {
      const output = await redacted(chunks, secrets);
      expect(output.replaceAll(MARKER, '')).toBe('xxyy');
    },
  );

  it('fails rather than cutting off when the marker outgrows the limit', async () => {
    await expectSecureFailure(
      redacted(['xxxxxxxx'], ['x'], { maxResponseBytes: 16 }),
      { code: SECURE_HTTP_ERROR_CODE.responseTooLarge },
    );
  });

  it('leaves no raw byte in the chunks it was given', async () => {
    const chunks = [
      encoder.encode(`head-${secret.slice(0, 5)}`),
      encoder.encode(`${secret.slice(5)}-tail`),
    ];
    const response = await clientFor(chunks).execute(
      request({ sensitiveValues: [secret], maxResponseBytes: LARGE }),
    );
    expect(decoder.decode(response.body)).toBe(`head-${MARKER}-tail`);
    for (const chunk of chunks)
      expect(chunk.every((byte) => byte === 0)).toBe(true);
  });
});

describe('a body built to make redaction slow', () => {
  // Every position in the body matches half the secret before it stops. This
  // shape took 11.3 s without a yield on 10 MiB with a whole-pattern `indexOf`.
  const hostileSecret = `${'a'.repeat(512)}b${'a'.repeat(511)}`;

  it('hits its deadline, with the event loop running throughout', async () => {
    const startedAt = performance.now();
    const { turns, outcome } = await countingTurns(() =>
      redacted(['a'.repeat(1_048_576)], [hostileSecret], {
        timeoutMillis: 100,
      }),
    );
    expect(outcome).toMatchObject({
      status: 'rejected',
      reason: { code: SECURE_HTTP_ERROR_CODE.timedOut },
    });
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(turns).toBeGreaterThan(5);
  });

  it('stops scanning once its deadline has passed', async () => {
    let scanEnded = false;
    const client = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      new FakeTransport(() =>
        Promise.resolve({
          status: 200,
          headers: {},
          close: vi.fn(),
          body: {
            async *[Symbol.asyncIterator]() {
              try {
                await Promise.resolve();
                yield encoder.encode('a'.repeat(1_048_576));
              } finally {
                // Reached only when the scan of this chunk has given up.
                scanEnded = true;
              }
            },
          },
        }),
      ),
    );
    await expectSecureFailure(
      client.execute(
        request({
          sensitiveValues: [hostileSecret],
          maxResponseBytes: LARGE,
          timeoutMillis: 100,
        }),
      ),
      { code: SECURE_HTTP_ERROR_CODE.timedOut },
    );
    await expect.poll(() => scanEnded, { timeout: 3_000 }).toBe(true);
  });

  it('can be cancelled part way, and clears what it held', async () => {
    const controller = new AbortController();
    const chunk = encoder.encode('a'.repeat(1_048_576));
    const startedAt = performance.now();
    setTimeout(() => {
      controller.abort();
    }, 50);
    await expectSecureFailure(
      clientFor([chunk]).execute(
        request({
          signal: controller.signal,
          sensitiveValues: [hostileSecret],
          maxResponseBytes: LARGE,
          timeoutMillis: 30_000,
        }),
      ),
      { code: SECURE_HTTP_ERROR_CODE.canceled },
    );
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(chunk.every((byte) => byte === 0)).toBe(true);
  });

  it('comes back untouched when it holds no secret, without blocking', async () => {
    const body = 'a'.repeat(8_192);
    const { turns, outcome } = await countingTurns(() =>
      redacted([body], [hostileSecret]),
    );
    expect(outcome).toEqual({ status: 'fulfilled', value: body });
    // 8 KiB here costs millions of comparisons, and it yields every few thousand.
    expect(turns).toBeGreaterThan(100);
  });

  it('stays responsive with the most secrets a request can carry', async () => {
    const secrets = Array.from(
      { length: 64 },
      (_, index) => `${'a'.repeat(512)}${String(index).padStart(2, '0')}`,
    );
    const { turns, outcome } = await countingTurns(() =>
      redacted(['a'.repeat(1_048_576)], secrets, { timeoutMillis: 100 }),
    );
    expect(outcome).toMatchObject({
      status: 'rejected',
      reason: { code: SECURE_HTTP_ERROR_CODE.timedOut },
    });
    expect(turns).toBeGreaterThan(5);
  });
});
