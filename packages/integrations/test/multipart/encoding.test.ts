import { createHash, randomUUID } from 'node:crypto';
import FormData from 'form-data';
import { describe, expect, it, vi } from 'vitest';
import type { NodeArtifactRuntime } from '@pertexo/node-sdk/server';
import {
  httpRequestInputSchema,
  httpMultipartConfigSchema,
} from '../../src/index.js';
import { encodeMultipart } from '../../src/http-request/multipart/encode.js';

const textKey = 'part_11111111-1111-4111-8111-111111111111';
const fileKey = 'part_22222222-2222-4222-8222-222222222222';
const secondKey = 'part_33333333-3333-4333-8333-333333333333';
const signal = new AbortController().signal;
function reference(bytes: Uint8Array) {
  return {
    kind: 'artifact',
    artifactId: '44444444-4444-4444-8444-444444444444',
    byteLength: bytes.byteLength,
    mediaType: 'application/octet-stream',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
function runtime(bytes: Uint8Array) {
  const copies: Uint8Array[] = [];
  const read = vi.fn<NonNullable<NodeArtifactRuntime['read']>>(() => {
    const copy = Uint8Array.from(bytes);
    copies.push(copy);
    return Promise.resolve(copy);
  });
  return { artifacts: { read, write: vi.fn() }, read, copies };
}
function encode(
  config: unknown,
  values: unknown,
  artifacts?: NodeArtifactRuntime,
) {
  return encodeMultipart({
    config: httpMultipartConfigSchema.parse(config),
    values: httpRequestInputSchema.parse(values),
    artifacts,
    signal,
  });
}
async function parsed(body: Uint8Array, contentType: string) {
  return new Request('http://owned.example.test', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: Buffer.from(body),
  }).formData();
}
describe('bounded multipart encoding', () => {
  it('preserves duplicate field order, exact Unicode/newline text, empty bytes and deliberate metadata', async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    const store = runtime(bytes);
    const result = await encode(
      {
        parts: [
          { inputKey: textKey, name: 'same', kind: 'text' },
          {
            inputKey: fileKey,
            name: 'upload',
            kind: 'file',
            filename: 'report.bin',
            contentType: 'application/x-owned',
          },
          {
            inputKey: secondKey,
            name: 'same',
            kind: 'text',
            contentType: 'text/plain; charset=utf-8',
          },
        ],
      },
      {
        [textKey]: '€ first\r\nsecond',
        [fileKey]: reference(bytes),
        [secondKey]: '',
      },
      store.artifacts,
    );
    const form = await parsed(result.body, result.contentType);
    expect(Array.from(form.keys())).toEqual(['same', 'upload', 'same']);
    expect(form.getAll('same')).toEqual(['€ first\r\nsecond', '']);
    const file = form.get('upload');
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error('Expected binary part');
    expect(file.name).toBe('report.bin');
    expect(file.type).toBe('application/x-owned');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(
      store.copies.every((copy) => copy.every((value) => value === 0)),
    ).toBe(true);
    expect(store.read).toHaveBeenCalledWith({
      reference: {
        artifactId: reference(bytes).artifactId,
        byteLength: bytes.length,
        mediaType: 'application/octet-stream',
        sha256: reference(bytes).sha256,
      },
      maxBytes: 1048576,
      signal,
    });
  });
  it('preserves UTF-8 field names and filenames with standard quoted parameter escaping', async () => {
    const store = runtime(new Uint8Array([1]));
    const result = await encode(
      {
        parts: [
          {
            inputKey: fileKey,
            name: 'données',
            kind: 'file',
            filename: '日.bin',
          },
        ],
      },
      { [fileKey]: reference(new Uint8Array([1])) },
      store.artifacts,
    );
    const form = await parsed(result.body, result.contentType);
    const file = form.get('données');
    if (!(file instanceof File)) throw new Error('Expected Unicode-named file');
    expect(file.name).toBe('日.bin');
  });
  it('uses a default file name/type and supports an explicit filename on UTF-8 text', async () => {
    const store = runtime(new Uint8Array());
    const result = await encode(
      {
        parts: [
          { inputKey: fileKey, name: 'empty', kind: 'file' },
          {
            inputKey: textKey,
            name: 'note',
            kind: 'text',
            filename: 'note.txt',
            contentType: 'text/x-owned',
          },
        ],
      },
      { [fileKey]: reference(new Uint8Array()), [textKey]: 'hello' },
      store.artifacts,
    );
    const form = await parsed(result.body, result.contentType);
    const file = form.get('empty');
    const note = form.get('note');
    if (!(file instanceof File) || !(note instanceof File))
      throw new Error('Expected named parts');
    expect({ name: file.name, type: file.type, size: file.size }).toEqual({
      name: 'file',
      type: 'application/octet-stream',
      size: 0,
    });
    expect({
      name: note.name,
      type: note.type,
      text: await note.text(),
    }).toEqual({ name: 'note.txt', type: 'text/x-owned', text: 'hello' });
  });
  it('refuses a lower-bound overrun before file reads, counting each occurrence', async () => {
    const store = runtime(new Uint8Array(600000));
    await expect(
      encode(
        {
          parts: [
            { inputKey: fileKey, name: 'one', kind: 'file' },
            { inputKey: secondKey, name: 'two', kind: 'file' },
          ],
        },
        {
          [fileKey]: reference(new Uint8Array(600000)),
          [secondKey]: reference(new Uint8Array(600000)),
        },
        store.artifacts,
      ),
    ).rejects.toMatchObject({ diagnostic: { reason: 'multipart_size' } });
    expect(store.read).not.toHaveBeenCalled();
  });
  it('refuses a large finalized-file reference with split-file diagnostics before storage reads', async () => {
    const store = runtime(new Uint8Array());
    await expect(
      encode(
        { parts: [{ inputKey: fileKey, name: 'file', kind: 'file' }] },
        { [fileKey]: { ...reference(new Uint8Array()), byteLength: 2097152 } },
        store.artifacts,
      ),
    ).rejects.toMatchObject({ diagnostic: { reason: 'multipart_size' } });
    expect(store.read).not.toHaveBeenCalled();
  });
  it('measures an exact 1 MiB wire body and refuses one byte over, including framing', async () => {
    const config = {
      parts: [{ inputKey: fileKey, name: 'file', kind: 'file' }],
    };
    const empty = runtime(new Uint8Array());
    const overhead = (
      await encode(
        config,
        { [fileKey]: reference(new Uint8Array()) },
        empty.artifacts,
      )
    ).body.byteLength;
    const bytes = new Uint8Array(1048576 - overhead).fill(7);
    const store = runtime(bytes);
    const start = performance.now();
    const result = await encode(
      config,
      { [fileKey]: reference(bytes) },
      store.artifacts,
    );
    expect(result.body.byteLength).toBe(1048576);
    const form = await parsed(result.body, result.contentType);
    const file = form.get('file');
    if (!(file instanceof File)) throw new Error('Expected file');
    expect(
      createHash('sha256')
        .update(Buffer.from(await file.arrayBuffer()))
        .digest('hex'),
    ).toBe(reference(bytes).sha256);
    process.stdout.write(
      `Multipart exact 1 MiB: ${String(Math.round(performance.now() - start))} ms; framing ${String(overhead)} bytes; one bounded file view plus final wire buffer\n`,
    );
    const over = runtime(new Uint8Array(bytes.length + 1));
    await expect(
      encode(
        config,
        { [fileKey]: reference(new Uint8Array(bytes.length + 1)) },
        over.artifacts,
      ),
    ).rejects.toMatchObject({ diagnostic: { reason: 'multipart_size' } });
    const full = runtime(new Uint8Array(1048576));
    await expect(
      encode(
        config,
        { [fileKey]: reference(new Uint8Array(1048576)) },
        full.artifacts,
      ),
    ).rejects.toMatchObject({ diagnostic: { reason: 'multipart_size' } });
    expect(full.read).not.toHaveBeenCalled();
  });
  it('measures the full 64-part form at the wire maximum, including encoder temporary copies', async () => {
    const tail = Array.from({ length: 63 }, () => ({
      inputKey: `part_${randomUUID()}`,
      name: 'note',
      kind: 'text' as const,
    }));
    const config = {
      parts: [{ inputKey: fileKey, name: 'file', kind: 'file' }, ...tail],
    };
    const emptyValues = Object.fromEntries(
      tail.map((part) => [part.inputKey, '']),
    );
    const overhead = (
      await encode(
        config,
        { ...emptyValues, [fileKey]: reference(new Uint8Array()) },
        runtime(new Uint8Array()).artifacts,
      )
    ).body.byteLength;
    const bytes = new Uint8Array(1048576 - overhead).fill(11);
    const bufferBaseline = process.memoryUsage().arrayBuffers;
    const start = performance.now();
    const result = await encode(
      config,
      { ...emptyValues, [fileKey]: reference(bytes) },
      runtime(bytes).artifacts,
    );
    const growth = process.memoryUsage().arrayBuffers - bufferBaseline;
    expect(result.body.byteLength).toBe(1048576);
    const form = await parsed(result.body, result.contentType);
    expect(Array.from(form.keys())).toHaveLength(64);
    const file = form.get('file');
    if (!(file instanceof File)) throw new Error('Expected maximum-size file');
    expect(
      createHash('sha256')
        .update(Buffer.from(await file.arrayBuffer()))
        .digest('hex'),
    ).toBe(reference(bytes).sha256);
    process.stdout.write(
      `Multipart 64-part maximum: ${String(Math.round(performance.now() - start))} ms; ${String(overhead)} framing bytes; ${String(growth)} bytes array-buffer growth before independent parsing\n`,
    );
  });
  it.each([
    {},
    { [textKey]: 'one', [fileKey]: 'extra' },
    { body: { encoding: 'utf8', value: 'raw' }, [textKey]: 'one' },
    { [textKey]: reference(new Uint8Array()) },
  ])(
    'refuses missing, extra, mixed or wrong-kind values %#',
    async (values) => {
      await expect(
        encode(
          { parts: [{ inputKey: textKey, name: 'text', kind: 'text' }] },
          values,
        ),
      ).rejects.toMatchObject({ diagnostic: { reason: 'multipart_values' } });
    },
  );
  it('regenerates a colliding boundary and fails closed after its bounded attempts', async () => {
    const config = {
      parts: [{ inputKey: textKey, name: 'text', kind: 'text' }],
    };
    const boundary = vi
      .spyOn(FormData.prototype, 'getBoundary')
      .mockReturnValueOnce('collision')
      .mockReturnValue('safe-boundary');
    try {
      const result = await encode(config, { [textKey]: 'collision' });
      expect(result.contentType).toContain('safe-boundary');
      expect((await parsed(result.body, result.contentType)).get('text')).toBe(
        'collision',
      );
      boundary.mockReturnValue('collision');
      await expect(
        encode(config, { [textKey]: 'collision' }),
      ).rejects.toMatchObject({ diagnostic: { reason: 'multipart_boundary' } });
    } finally {
      boundary.mockRestore();
    }
  });
  it('zeroes earlier file buffers when a later read fails or is canceled', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const store = runtime(bytes);
    store.read
      .mockImplementationOnce(() => Promise.resolve(bytes))
      .mockRejectedValueOnce(new Error('Temporary storage failure'));
    await expect(
      encode(
        {
          parts: [
            { inputKey: fileKey, name: 'first', kind: 'file' },
            { inputKey: secondKey, name: 'second', kind: 'file' },
          ],
        },
        { [fileKey]: reference(bytes), [secondKey]: reference(bytes) },
        store.artifacts,
      ),
    ).rejects.toThrow('Temporary storage failure');
    expect(bytes.every((value) => value === 0)).toBe(true);
  });
});
