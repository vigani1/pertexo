import { describe, expect, it } from 'vitest';

import { SecureHttpClient } from '../../src/server.js';
import {
  FakeResolver,
  FakeTransport,
  decoder,
  request,
  transportResponse,
} from '../support/http-client.js';

const TEN_MIB = 10 * 1024 * 1024;

function client(chunks: readonly string[]) {
  const resolver = new FakeResolver({
    'api.example.test': [{ address: '8.8.8.8', family: 4 }],
  });
  const fixture = transportResponse(200, {}, [...chunks]);
  return new SecureHttpClient(
    resolver,
    new FakeTransport(() => Promise.resolve(fixture.response)),
  );
}

async function redact(
  chunks: readonly string[],
  sensitiveValues: readonly string[],
): Promise<string> {
  const response = await client(chunks).execute(request({ sensitiveValues }));
  return decoder.decode(response.body);
}

describe('response redaction', () => {
  it('reads an ordinary large response in a handful of event loop turns', async () => {
    const line = 'the quick brown fox jumps over the lazy dog\n';
    const filler = line.repeat(Math.floor((TEN_MIB - 64) / 2 / line.length));
    const secret = 'sk-live-0123456789';
    // The secret is split across the two chunks, as a network would split it.
    const chunks = [
      `${filler}${secret.slice(0, 7)}`,
      `${secret.slice(7)}${filler}`,
    ];
    let turns = 0;
    let counting = true;
    const countTurns = (): void => {
      turns += 1;
      if (counting) setImmediate(countTurns);
    };
    setImmediate(countTurns);
    const response = await client(chunks).execute(
      request({
        sensitiveValues: [secret],
        maxResponseBytes: TEN_MIB,
      }),
    );
    counting = false;
    const body = decoder.decode(response.body);
    expect(body).toBe(`${filler}[Redacted]${filler}`);
    // Walking byte by byte took thousands of turns on this body.
    expect(turns).toBeLessThan(500);
  });

  it.each([
    {
      rule: 'a secret split at every possible byte',
      chunks: ['xx-se', 'cr', 'et-yy'],
      sensitiveValues: ['-secret-'],
      expected: 'xx[Redacted]yy',
    },
    {
      rule: 'the longest secret where several start at the same byte',
      chunks: ['ab', 'cd'],
      sensitiveValues: ['ab', 'abcd'],
      expected: '[Redacted]',
    },
    {
      rule: 'both secrets when two overlap',
      chunks: ['abcde'],
      sensitiveValues: ['bcde', 'ab'],
      expected: '[Redacted]',
    },
    {
      rule: 'every occurrence, including ones that touch',
      chunks: ['keykey-key'],
      sensitiveValues: ['key'],
      expected: '[Redacted][Redacted]-[Redacted]',
    },
    {
      rule: 'the start of a secret that never finishes',
      chunks: ['abc', 'abd'],
      sensitiveValues: ['abcabx'],
      expected: 'abcabd',
    },
    {
      rule: 'a secret restarting inside a near match',
      chunks: ['aaab'],
      sensitiveValues: ['aab'],
      expected: 'a[Redacted]',
    },
    {
      rule: 'a secret at the very end of the body',
      chunks: ['xy', 'z'],
      sensitiveValues: ['z'],
      expected: 'xy[Redacted]',
    },
    {
      rule: 'a secret in multi-byte text',
      chunks: ['é-sé', 'cret-é'],
      sensitiveValues: ['sécret'],
      expected: 'é-[Redacted]-é',
    },
  ])('removes $rule', async ({ chunks, sensitiveValues, expected }) => {
    await expect(redact(chunks, sensitiveValues)).resolves.toBe(expected);
  });
});
