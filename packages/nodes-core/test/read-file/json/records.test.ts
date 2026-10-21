import { describe, expect, it } from 'vitest';
import type {
  JsonValue,
  EncodedFilePageRecord,
} from '@pertexo/node-sdk/server';
import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import { readJsonRecords } from '../../../src/data/read-file/json/records.js';

async function* chunks(text: string, size = 65_536) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += size)
    yield await Promise.resolve(bytes.subarray(offset, offset + size));
}
function collect(text: string, size?: number) {
  return collectValues(
    readJsonRecords(chunks(text, size), new AbortController().signal),
  );
}

async function collectValues(
  source: AsyncIterable<EncodedFilePageRecord>,
): Promise<JsonValue[]> {
  const values: JsonValue[] = [];
  for await (const value of source)
    values.push(JSON.parse(value.json) as JsonValue);
  return values;
}

describe('bounded streaming JSON records', () => {
  it('preserves order, exact values, BOM and Unicode across every byte boundary', async () => {
    const input =
      '\ufeff[{"currency":"€","name":"😀","text":"a\\nb"},false,null,1e2,[],{"__proto__":{"ok":true}}]';
    const actual = await collect(input, 1);
    expect(actual).toEqual(JSON.parse(input.slice(1)));
    expect(Object.getPrototypeOf(actual[5])).toBe(Object.prototype);
  });
  it('accepts surrogate escapes split between chunks and bounded escaped whitespace', async () => {
    expect(await collect('["\\ud83d\\ude00"]', 1)).toEqual(['😀']);
    const text = ' '.repeat(FILE_PAGE_LIMITS.bytes - 4);
    expect(
      await collect('["' + '\\u0020'.repeat(text.length) + '"]', 997),
    ).toEqual([text]);
  });
  it('does not mistake long legal whitespace for an oversized token', async () => {
    expect(await collect('[1,' + ' '.repeat(1_048_576) + '2]')).toEqual([1, 2]);
  });
  it('accepts the exact file-byte ceiling and refuses one byte beyond it', async () => {
    async function* source(extra: number) {
      yield await Promise.resolve(Buffer.from('['));
      let remaining = FILE_PAGE_LIMITS.fileBytes - 2 + extra;
      while (remaining > 0) {
        const size = Math.min(65_536, remaining);
        yield Buffer.alloc(size, 0x20);
        remaining -= size;
      }
      yield Buffer.from(']');
    }
    expect(
      await collectValues(
        readJsonRecords(source(0), new AbortController().signal),
      ),
    ).toEqual([]);
    await expect(
      collectValues(readJsonRecords(source(1), new AbortController().signal)),
    ).rejects.toMatchObject({ diagnostic: { reason: 'file_size' } });
  });
  it('explains that a valid JSON object needs inline mode or a list export', async () => {
    await expect(collect('{}')).rejects.toMatchObject({
      diagnostic: { reason: 'page_array' },
    });
  });
  it('accepts an empty array', async () => {
    expect(await collect('[]')).toEqual([]);
  });
  it('accepts the exact one-record page budget and refuses one byte more', async () => {
    const text = 'x'.repeat(FILE_PAGE_LIMITS.bytes - 4);
    expect(await collect(JSON.stringify([text]))).toEqual([text]);
    await expect(collect(JSON.stringify([text + 'x']))).rejects.toMatchObject({
      diagnostic: { reason: 'page_value_size' },
    });
  });
  it.each([
    '{}',
    'null',
    '',
    '[1,]',
    '["unterminated',
    '[1]x',
    '[1][2]',
    '[1e9999]',
    '["\\u0000"]',
    '["\\ud800"]',
  ])(
    'refuses malformed or unretainable data without its contents: %s',
    async (input) => {
      await expect(collect(input)).rejects.toMatchObject({
        safeErrorCode: 'execution.file_input',
        possiblyDispatched: false,
      });
    },
  );
  it('refuses a malformed final UTF-8 byte', async () => {
    async function* source() {
      yield await Promise.resolve(Buffer.from('["ok","'));
      yield Buffer.from([0xc3, 0x22, 0x5d]);
    }
    await expect(
      collectValues(readJsonRecords(source(), new AbortController().signal)),
    ).rejects.toMatchObject({ safeErrorCode: 'execution.file_input' });
  });
  it('bounds nesting and member allocation before a hostile record is assembled', async () => {
    await expect(collect('[' + '['.repeat(100_000))).rejects.toMatchObject({
      diagnostic: { reason: 'page_value_size' },
    });
    await expect(collect('[[' + '0,'.repeat(100_000))).rejects.toMatchObject({
      diagnostic: { reason: 'page_value_size' },
    });
  });
  it('bounds incomplete exponents even when the tokenizer emits no useful partial value', async () => {
    let supplied = 0;
    let returned = false;
    async function* source() {
      try {
        yield await Promise.resolve(Buffer.from('[1e'));
        for (let index = 0; index < 160; index++) {
          supplied += 65_536;
          yield Buffer.alloc(65_536, 48);
        }
      } finally {
        returned = true;
      }
    }
    await expect(
      collectValues(readJsonRecords(source(), new AbortController().signal)),
    ).rejects.toMatchObject({ diagnostic: { reason: 'page_value_size' } });
    expect(supplied).toBeLessThan(512 * 1024);
    expect(returned).toBe(true);
  });
  it('closes its source on cancellation without reading another chunk', async () => {
    const controller = new AbortController();
    let returned = false;
    async function* source() {
      try {
        yield await Promise.resolve(Buffer.from('[1,'));
        controller.abort();
        yield Buffer.from('2]');
      } finally {
        returned = true;
      }
    }
    await expect(
      collectValues(readJsonRecords(source(), controller.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(returned).toBe(true);
  });
  it('does not read ahead while a consumer is paused', async () => {
    let read = 0;
    async function* source() {
      read++;
      yield await Promise.resolve(Buffer.from('[1,'));
      read++;
      yield Buffer.from('2]');
    }
    const iterator = readJsonRecords(source(), new AbortController().signal);
    expect((await iterator.next()).value).toMatchObject({ json: '1' });
    expect(read).toBe(1);
    await iterator.return(undefined);
  });
});
