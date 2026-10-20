import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCoreNodeRegistry } from '../../src/server.js';
const registry = createCoreNodeRegistry();
const run = (
  key: string,
  config: unknown,
  input: unknown,
  signal = new AbortController().signal,
) =>
  registry.execute({
    definition: { key: `core.${key}`, version: 1 },
    executor: { key: `core.${key}`, version: 1 },
    config,
    input,
    signal,
  });

describe('text, numbers and crypto utilities', () => {
  it.each([
    ['uppercase', 'Straße İ i', 'STRASSE İ I'],
    ['lowercase', 'İ STRASSE', 'i̇ strasse'],
    ['trim', '\t hello \n', 'hello'],
  ])(
    'formats %s without guessing data types',
    async (operation, value, expected) => {
      expect(await run('text', { operation }, { value })).toMatchObject({
        output: { value: expected },
      });
    },
  );
  it('replaces literals, preserves dollar replacement text and handles first/all', async () => {
    expect(
      await run(
        'text',
        { operation: 'replace', all: true },
        { value: 'a.* a.*', search: 'a.*', replacement: '$&' },
      ),
    ).toMatchObject({ output: { value: '$& $&' } });
    expect(
      await run(
        'text',
        { operation: 'replace', all: false },
        { value: 'a a', search: 'a', replacement: '' },
      ),
    ).toMatchObject({ output: { value: ' a' } });
    await expect(
      run(
        'text',
        { operation: 'replace', all: true },
        { value: 'abc', search: '', replacement: 'x' },
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.text_fields' });
  });
  it('refuses expanding replacements before building an oversized result', async () => {
    await expect(
      run(
        'text',
        { operation: 'replace', all: true },
        {
          value: 'a'.repeat(100_000),
          search: 'a',
          replacement: 'x'.repeat(100_000),
        },
      ),
    ).rejects.toMatchObject({
      safeErrorCode: 'utility.result_too_large',
      possiblyDispatched: false,
    });
  });
  it('splits exact delimiters, keeps empty items and refuses too many', async () => {
    expect(
      await run(
        'text',
        { operation: 'split' },
        { value: 'a||b|', delimiter: '|' },
      ),
    ).toMatchObject({ output: { value: ['a', '', 'b', ''] } });
    await expect(
      run(
        'text',
        { operation: 'split' },
        { value: 'x|'.repeat(4_998), delimiter: '|' },
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.too_many_items' });
    await expect(
      run('text', { operation: 'split' }, { value: 'abc', delimiter: '' }),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.text_fields' });
  });
  it('truncates by code point with ellipsis inside the limit', async () => {
    expect(
      await run(
        'text',
        { operation: 'truncate', length: 3, ellipsis: true },
        { value: 'a😀bc' },
      ),
    ).toMatchObject({ output: { value: 'a😀…' } });
    expect(
      await run(
        'text',
        { operation: 'truncate', length: 1, ellipsis: true },
        { value: '😀abc' },
      ),
    ).toMatchObject({ output: { value: '…' } });
    expect(
      await run(
        'text',
        { operation: 'truncate', length: 2, ellipsis: false },
        { value: 'a😀bc' },
      ),
    ).toMatchObject({ output: { value: 'a😀' } });
  });
  it('formats numbers with an explicit locale and no implicit text conversion', async () => {
    const base = {
      locale: 'de-DE',
      grouping: true,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    };
    expect(
      await run('number', { operation: 'decimal', ...base }, { value: 1234.5 }),
    ).toMatchObject({ output: { value: '1.234,50' } });
    expect(
      await run(
        'number',
        { operation: 'percent', ...base, locale: 'en-US' },
        { value: 0.25 },
      ),
    ).toMatchObject({ output: { value: '25.00%' } });
    expect(
      await run(
        'number',
        { operation: 'currency', ...base, locale: 'en-US', currency: 'EUR' },
        { value: 12.3 },
      ),
    ).toMatchObject({ output: { value: '€12.30' } });
    await expect(
      run('number', { operation: 'decimal', ...base }, { value: '123' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      run(
        'number',
        { operation: 'decimal', ...base, minimumFractionDigits: 3 },
        { value: 12 },
      ),
    ).rejects.toMatchObject({ code: 'invalid_config' });
  });
  it.each(['sha256', 'sha512', 'md5'])(
    'hashes exact UTF-8 with %s',
    async (algorithm) => {
      for (const encoding of ['hex', 'base64'] as const)
        expect(
          await run(
            'crypto',
            { operation: 'hash', algorithm, encoding },
            { value: 'Pertexo 😃\n' },
          ),
        ).toMatchObject({
          output: {
            value: createHash(algorithm)
              .update('Pertexo 😃\n')
              .digest(encoding),
          },
        });
    },
  );
  it('requires hash data and generates random URL-safe IDs and UUIDs', async () => {
    await expect(
      run(
        'crypto',
        { operation: 'hash', algorithm: 'sha256', encoding: 'hex' },
        {},
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.crypto_input' });
    const uuid = await run('crypto', { operation: 'uuid' }, {});
    expect(uuid.output).toHaveProperty(
      'value',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    );
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const result = await run(
        'crypto',
        { operation: 'random_id', length: 256 },
        {},
      );
      const value = (result.output as { value: string }).value;
      expect(value).toMatch(/^[A-Za-z0-9_-]{256}$/u);
      ids.add(value);
    }
    expect(ids.size).toBe(100);
  });
  it('honors cancellation and the unchanged whole-input envelope', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      run('crypto', { operation: 'uuid' }, {}, controller.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
    await expect(
      run('text', { operation: 'trim' }, { value: 'x'.repeat(1_048_576) }),
    ).rejects.toMatchObject({ code: 'invalid_json' });
  });
  it('accepts the exact retained output ceiling and refuses one extra byte before persistence', async () => {
    const value = 'x'.repeat(STORED_EXECUTION_VALUE_LIMITS.inlineBytes - 12);
    expect(
      (
        (await run('text', { operation: 'trim' }, { value })).output as {
          value: string;
        }
      ).value.length,
    ).toBe(value.length);
    await expect(
      run('text', { operation: 'trim' }, { value: value + 'x' }),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.result_too_large' });
  });
  it.each(['\u0000', '\ud800', '\udc00'])(
    'refuses text the existing persistence contract cannot store',
    async (value) => {
      await expect(
        run('text', { operation: 'trim' }, { value }),
      ).rejects.toMatchObject({ safeErrorCode: 'utility.result_text' });
    },
  );
});
