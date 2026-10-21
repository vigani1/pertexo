import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  filePageBundleSchema,
  FILE_PAGE_LIMITS,
  STORED_EXECUTION_VALUE_LIMITS,
} from '../../src/index.js';
import { encodeFilePageRecord, writeFilePages } from '../../src/server.js';
import type {
  EncodedFilePageRecord,
  NodeArtifactRuntime,
} from '../../src/server.js';

async function* records(values: Iterable<unknown>) {
  for (const value of values)
    yield await Promise.resolve(encodeFilePageRecord(value));
}
async function* repeated(record: EncodedFilePageRecord, count: number) {
  for (let index = 0; index < count; index++)
    yield await Promise.resolve(record);
}
function storage(options: { failAt?: number; afterWrite?: () => void } = {}) {
  const files: Buffer[] = [];
  const owned: Uint8Array[] = [];
  const write = vi.fn<NodeArtifactRuntime['write']>(async (input) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input.body) {
      input.signal.throwIfAborted();
      expect(chunk.byteLength).toBeLessThanOrEqual(65536);
      owned.push(chunk);
      chunks.push(Uint8Array.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    expect(bytes.byteLength).toBeLessThanOrEqual(input.maxBytes);
    if (options.failAt === write.mock.calls.length)
      throw new Error('Private storage failure');
    files.push(bytes);
    options.afterWrite?.();
    return {
      artifactId: randomUUID(),
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: input.mediaType,
    };
  });
  return { files, owned, write };
}
const signal = () => new AbortController().signal;

describe('explicit immutable file pages', () => {
  it('keeps order and exact UTF-8, and returns a zero-file bundle for an empty list', async () => {
    const empty = storage();
    await expect(writeFilePages(records([]), empty, signal())).resolves.toEqual(
      { pages: [], itemCount: 0, pageCount: 0 },
    );
    expect(empty.write).not.toHaveBeenCalled();
    const store = storage();
    const values = [{ id: 1, text: '€\n"a"' }, null, true, 0, ['a', 'b']];
    const bundle = await writeFilePages(records(values), store, signal());
    expect(filePageBundleSchema.parse(bundle)).toEqual(bundle);
    expect(bundle).toMatchObject({ itemCount: 5, pageCount: 1 });
    expect(
      JSON.parse(store.files[0]?.toString('utf8') ?? '') as unknown,
    ).toEqual(values);
    expect(bundle.pages[0]?.sha256).toBe(
      createHash('sha256')
        .update(store.files[0] ?? Buffer.alloc(0))
        .digest('hex'),
    );
    expect(store.write.mock.calls[0]?.[0]).toMatchObject({
      purpose: 'node-output',
      mediaType: 'application/json',
    });
    expect(
      store.owned.every((bytes) => bytes.every((value) => value === 0)),
    ).toBe(true);
  });
  it('starts another page after 1,000 records and after the member budget', async () => {
    const store = storage();
    const bundle = await writeFilePages(
      records(Array.from({ length: 1001 }, (_, index) => index)),
      store,
      signal(),
    );
    expect(bundle.pageCount).toBe(2);
    expect(
      store.files.map(
        (bytes) => (JSON.parse(bytes.toString()) as unknown[]).length,
      ),
    ).toEqual([1000, 1]);
    const wide = storage();
    const value = Object.fromEntries(
      Array.from({ length: 1999 }, (_, index) => ['field' + String(index), 0]),
    );
    await writeFilePages(records([value, value, value]), wide, signal());
    expect(
      wide.files.map(
        (bytes) => (JSON.parse(bytes.toString()) as unknown[]).length,
      ),
    ).toEqual([2, 1]);
  });
  it('accepts exactly 64 KiB with split UTF-8 text and rejects one byte over without writing', async () => {
    const value = '€'.repeat(21843) + 'abc';
    const store = storage();
    await writeFilePages(records([value]), store, signal());
    expect(store.files[0]?.byteLength).toBe(65536);
    expect(JSON.parse(store.files[0]?.toString() ?? '') as unknown).toEqual([
      value,
    ]);
    const over = storage();
    await expect(
      writeFilePages(records([value + 'x']), over, signal()),
    ).rejects.toMatchObject({ safeErrorCode: 'file.pages_record' });
    expect(over.write).not.toHaveBeenCalled();
  });
  it('enforces depth and member limits before admitting one record', () => {
    let deep: unknown = 0;
    for (let index = 0; index < 47; index++) deep = [deep];
    expect(() => encodeFilePageRecord(deep)).not.toThrow();
    expect(() => encodeFilePageRecord([deep])).toThrow();
    expect(() =>
      encodeFilePageRecord(
        Object.fromEntries(
          Array.from({ length: 4000 }, (_, index) => ['x' + String(index), 0]),
        ),
      ),
    ).toThrow();
    for (const value of ['zero\0byte', '\ud800', { '\udc00': 'bad' }, () => 42])
      expect(() => encodeFilePageRecord(value)).toThrow();
  });
  it('accepts exactly ten MiB and refuses an aggregate one byte over', async () => {
    const full = encodeFilePageRecord('x'.repeat(65532));
    const store = storage();
    const bundle = await writeFilePages(repeated(full, 160), store, signal());
    expect(
      store.files.reduce((total, file) => total + file.byteLength, 0),
    ).toBe(10485760);
    expect(bundle).toMatchObject({ itemCount: 160, pageCount: 160 });
    const row = { values: Array.from({ length: 3997 }, () => 0), text: '' };
    row.text = 'x'.repeat(65534 - Buffer.byteLength(JSON.stringify([row])));
    expect(Buffer.byteLength(JSON.stringify([row]))).toBe(65534);
    async function* oneOver() {
      yield* repeated(full, 159);
      yield encodeFilePageRecord(row);
      yield encodeFilePageRecord(0);
    }
    await expect(
      writeFilePages(oneOver(), storage(), signal()),
    ).rejects.toMatchObject({ safeErrorCode: 'file.pages_bytes' });
  });
  it('supports the full 100,000-record limit and refuses one more', async () => {
    const zero = encodeFilePageRecord(0);
    const store = storage();
    const result = await writeFilePages(
      repeated(zero, 100000),
      store,
      signal(),
    );
    expect(result).toMatchObject({ itemCount: 100000, pageCount: 100 });
    await expect(
      writeFilePages(repeated(zero, 100001), storage(), signal()),
    ).rejects.toMatchObject({ safeErrorCode: 'file.pages_items' });
  });
  it('bounds files at 256 and keeps the maximum descriptor below the unchanged retained envelope', async () => {
    const record = encodeFilePageRecord('x'.repeat(39996));
    const store = storage();
    const result = await writeFilePages(repeated(record, 256), store, signal());
    expect(result.pageCount).toBe(256);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
      STORED_EXECUTION_VALUE_LIMITS.inlineBytes,
    );
    expect(FILE_PAGE_LIMITS.pages).toBe(256);
    await expect(
      writeFilePages(repeated(record, 257), storage(), signal()),
    ).rejects.toMatchObject({ safeErrorCode: 'file.pages_pages' });
  });
  it('never returns a successful partial bundle after storage failure and closes the producer', async () => {
    let returned = false;
    async function* source() {
      try {
        yield* repeated(encodeFilePageRecord('x'.repeat(65532)), 3);
      } finally {
        returned = true;
      }
    }
    await expect(
      writeFilePages(source(), storage({ failAt: 2 }), signal()),
    ).rejects.toThrow('Private storage failure');
    expect(returned).toBe(true);
  });
  it('cancels after a finalized file without exposing a partial descriptor', async () => {
    const controller = new AbortController();
    const store = storage({
      afterWrite: () => {
        controller.abort();
      },
    });
    await expect(
      writeFilePages(
        repeated(encodeFilePageRecord('x'.repeat(65532)), 2),
        store,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.files).toHaveLength(1);
    expect(
      store.owned.every((bytes) => bytes.every((value) => value === 0)),
    ).toBe(true);
  });
});

it('refuses unavailable storage before consuming a page source', async () => {
  let read = false;
  async function* records() {
    read = true;
    yield await Promise.resolve(encodeFilePageRecord(1));
  }
  await expect(
    writeFilePages(records(), undefined, new AbortController().signal),
  ).rejects.toMatchObject({
    safeErrorCode: 'file.pages_storage',
    possiblyDispatched: false,
  });
  expect(read).toBe(false);
});
