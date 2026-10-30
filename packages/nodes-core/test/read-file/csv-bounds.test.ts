import { describe, expect, it } from 'vitest';
import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import { encodeFilePageRecord } from '@pertexo/node-sdk/server';
import { readCsvRecords } from '../../src/data/read-file/csv/records.js';

const config = { format: 'csv', delimiter: ',', convertValues: true } as const;
const signal = new AbortController().signal;
async function* chunks(content: Uint8Array, size = 1) {
  for (let i = 0; i < content.length; i += size)
    yield await Promise.resolve(content.subarray(i, i + size));
}
async function collect(content: Uint8Array) {
  const result: unknown[] = [];
  for await (const value of readCsvRecords(chunks(content), config, signal, {
    maxRecordSize: FILE_PAGE_LIMITS.bytes,
    accept: encodeFilePageRecord,
  }))
    result.push(JSON.parse(value.json));
  return result;
}
describe('paged CSV parser bounds and cleanup', () => {
  it('preserves strict UTF-8, BOM, quoting and prototype-named headers across byte boundaries', async () => {
    const text =
      '\ufeff__proto__,constructor,name\r\nvalue,"€","line\r\n😀"\r\n';
    expect(JSON.stringify(await collect(Buffer.from(text)))).toBe(
      '[{"__proto__":"value","constructor":"€","name":"line\\r\\n😀"}]',
    );
  });
  it('refuses a malformed final UTF-8 byte rather than returning the completed prefix', async () => {
    await expect(
      collect(Buffer.concat([Buffer.from('name\nok\n'), Buffer.from([0xc3])])),
    ).rejects.toMatchObject({ diagnostic: { reason: 'invalid_utf8' } });
  });
  it('bounds repeated long headers before assembling output beyond a page', async () => {
    await expect(
      collect(Buffer.from('a'.repeat(65520) + '\n' + '"'.repeat(2) + '\n')),
    ).resolves.toHaveLength(1);
    await expect(
      collect(Buffer.from('a'.repeat(65536) + '\nx\n')),
    ).rejects.toMatchObject({
      kind: 'failed',
      possiblyDispatched: false,
      safeErrorCode: 'file.pages_record',
    });
  });
  it('refuses one quoted field over a page before reading the rest of the file', async () => {
    let supplied = 0;
    async function* source() {
      yield await Promise.resolve(Buffer.from('name\n"'));
      for (let i = 0; i < 32; i++) {
        supplied += 65_536;
        yield Buffer.alloc(65_536, 'a');
      }
      yield Buffer.from('"\n');
    }
    const rows = readCsvRecords(source(), config, signal, {
      maxRecordSize: FILE_PAGE_LIMITS.bytes,
      accept: encodeFilePageRecord,
    });
    await expect(rows.next()).rejects.toMatchObject({
      safeErrorCode: 'execution.file_input',
      diagnostic: { reason: 'value_size' },
    });
    expect(supplied).toBeLessThan(4 * FILE_PAGE_LIMITS.bytes);
  });
  it('closes the source and makes bounded progress when the consumer stops after one row', async () => {
    let supplied = 0,
      closed = false;
    async function* source() {
      try {
        yield await Promise.resolve(Buffer.from('name\n'));
        for (let i = 0; i < 10000; i++) {
          supplied++;
          yield Buffer.from('a\n');
        }
      } finally {
        closed = true;
      }
    }
    const rows = readCsvRecords(source(), config, signal, {
      maxRecordSize: FILE_PAGE_LIMITS.bytes,
      accept: encodeFilePageRecord,
    });
    expect((await rows.next()).value).toMatchObject({ json: '{"name":"a"}' });
    await rows.return(undefined);
    expect(closed).toBe(true);
    expect(supplied).toBeLessThan(100);
  });
  it('propagates cancellation and closes the input iterator', async () => {
    let closed = false;
    const controller = new AbortController();
    async function* source() {
      try {
        yield await Promise.resolve(Buffer.from('name\nvalue\n'));
        controller.abort();
        yield Buffer.from('another\n');
      } finally {
        closed = true;
      }
    }
    const pending = (async () => {
      for await (const _row of readCsvRecords(
        source(),
        config,
        controller.signal,
        { maxRecordSize: FILE_PAGE_LIMITS.bytes, accept: encodeFilePageRecord },
      )) {
        /* Drain until canceled. */
      }
    })();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(closed).toBe(true);
  });
});
