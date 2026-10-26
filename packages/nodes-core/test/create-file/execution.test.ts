import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_INPUT_MAX_BYTES } from '@pertexo/node-sdk';
import type {
  NodeArtifactRuntime,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { createCoreNodeRegistry } from '../../src/server.js';
import { encodeFile } from '../../src/data/create-file/encode.js';

const registry = createCoreNodeRegistry();
const identity = { key: 'core.create_file', version: 1 };
function fixture(config: unknown, data: unknown) {
  const controller = new AbortController();
  const chunks: Uint8Array[] = [];
  let bytes = Buffer.alloc(0);
  const beforeDispatch = vi.fn();
  const write = vi.fn<NodeArtifactRuntime['write']>(async (input) => {
    const copies: Buffer[] = [];
    for await (const chunk of input.body) {
      chunks.push(chunk);
      copies.push(Buffer.from(chunk));
    }
    bytes = Buffer.concat(copies);
    return {
      artifactId: randomUUID(),
      byteLength: bytes.length,
      mediaType: input.mediaType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  const runtime: NodeExecutionRuntime = {
    workspaceId: 'workspace',
    runId: 'run',
    nodeRunId: 'node',
    attemptId: 'attempt',
    attemptNumber: 1,
    nodeId: 'create',
    invocationKey: 'root',
    sideEffectClass: 'safe',
    beforeDispatch,
    artifacts: { write },
  };
  const execute = () =>
    registry.execute({
      definition: identity,
      executor: identity,
      config,
      input: { data },
      signal: controller.signal,
      runtime,
    });
  return {
    controller,
    chunks,
    write,
    beforeDispatch,
    runtime,
    execute,
    bytes: () => bytes,
  };
}
const csv = { format: 'csv', delimiter: ',', columns: [] } as const;
describe('Create file through the existing runtime', () => {
  it.each([',', ';', '\t'])(
    'writes quoted UTF-8 CSV with chosen columns (%j)',
    async (delimiter) => {
      const config = {
        ...csv,
        delimiter,
        columns: ['name', 'amount', 'paid', 'nested', 'missing', 'constructor'],
      };
      const state = fixture(config, [
        {
          name: 'héllo,"world"\nnext',
          amount: -2,
          paid: true,
          nested: { a: 1 },
        },
        { name: '=SUM(A1)', amount: 0, paid: false, nested: null },
      ]);
      expect(await state.execute()).toMatchObject({
        kind: 'succeeded',
        output: {
          file: {
            kind: 'artifact',
            byteLength: state.bytes().length,
            mediaType: 'text/csv; charset=utf-8',
          },
        },
      });
      const rows: unknown = parse(state.bytes(), { columns: true, delimiter });
      expect(rows).toEqual([
        {
          name: 'héllo,"world"\nnext',
          amount: '-2',
          paid: 'true',
          nested: '{"a":1}',
          missing: '',
          constructor: '',
        },
        {
          name: "'=SUM(A1)",
          amount: '0',
          paid: 'false',
          nested: '',
          missing: '',
          constructor: '',
        },
      ]);
      expect(state.bytes().toString().split('\r\n')[0]).toBe(
        config.columns.map((name) => `"${name}"`).join(delimiter),
      );
      expect(state.beforeDispatch).not.toHaveBeenCalled();
      expect(state.write).toHaveBeenCalledWith(
        expect.objectContaining({
          maxBytes: ARTIFACT_INPUT_MAX_BYTES,
          purpose: 'node-output',
        }),
      );
      expect(
        state.chunks.every((chunk) => chunk.every((byte) => byte === 0)),
      ).toBe(true);
    },
  );
  it('discovers fields from later rows, keeps an explicit header for no rows, and protects header formulas', async () => {
    const inferred = fixture(csv, [{ a: 1 }, { b: 2 }]);
    await inferred.execute();
    expect(parse(inferred.bytes(), { columns: true })).toEqual([
      { a: '1', b: '' },
      { a: '', b: '2' },
    ]);
    const empty = fixture({ ...csv, columns: ['=title', 'other'] }, []);
    await empty.execute();
    expect(empty.bytes().toString()).toBe('"\'=title","other"\r\n');
    await expect(fixture(csv, []).execute()).rejects.toMatchObject({
      safeErrorCode: 'file.create_columns',
    });
  });
  it('writes exact plain text and JSON values without implicit conversions', async () => {
    const text = fixture({ format: 'text' }, 'héllo\nworld');
    await text.execute();
    expect(text.bytes().toString()).toBe('héllo\nworld');
    const json = fixture(
      { format: 'json' },
      { null: null, array: [true, 1, '00123'] },
    );
    await json.execute();
    expect(JSON.parse(json.bytes().toString())).toEqual({
      null: null,
      array: [true, 1, '00123'],
    });
    await expect(
      fixture({ format: 'text' }, { message: 'hello' }).execute(),
    ).rejects.toMatchObject({ safeErrorCode: 'file.create_data' });
  });
  it.each([null, {}, ['wrong'], [1], [null]])(
    'refuses invalid CSV rows without creating an artifact (%j)',
    async (data) => {
      const state = fixture(csv, data);
      await expect(state.execute()).rejects.toMatchObject({
        safeErrorCode: 'file.create_data',
        possiblyDispatched: false,
      });
      expect(state.write).not.toHaveBeenCalled();
    },
  );
  it('creates wide CSV exports that fit the shared bounds', async () => {
    const fields = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `field${String(index)}`,
        index,
      ]),
    );
    const state = fixture(csv, [fields]);
    await state.execute();
    const decoded: unknown = parse(state.bytes(), { columns: true });
    expect(decoded).toEqual([
      Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [name, String(value)]),
      ),
    ]);
  });
  it('enforces the collection and discovered-column bounds before storage', async () => {
    const many = fixture(
      csv,
      Array.from({ length: 4999 }, () => ({})),
    );
    await expect(many.execute()).rejects.toMatchObject({
      safeErrorCode: 'file.create_size',
    });
    expect(many.write).not.toHaveBeenCalled();
    const wide = fixture(csv, [
      Object.fromEntries(
        Array.from({ length: 4999 }, (_, i) => [`c${String(i)}`, i]),
      ),
    ]);
    await expect(wide.execute()).rejects.toMatchObject({
      safeErrorCode: 'file.create_size',
    });
    expect(wide.write).not.toHaveBeenCalled();
    await expect(fixture(csv, [{ ' ': 1 }]).execute()).rejects.toMatchObject({
      safeErrorCode: 'file.create_columns',
    });
  });
  it('accepts exactly 1 MiB including framing and refuses one more byte before writing', async () => {
    const config = {
      ...csv,
      columns: [
        'value',
        ...Array.from({ length: 63 }, (_, i) => `empty${String(i)}`),
      ],
    };
    const data = Array.from({ length: 1000 }, () => ({
      value: 'x'.repeat(700),
    }));
    const initial = await encodeFile(
      config,
      data,
      new AbortController().signal,
    );
    const initialSize = initial.bytes.byteLength;
    initial.bytes.fill(0);
    const last = data.at(-1);
    if (last === undefined) throw new Error('Missing row');
    last.value += 'x'.repeat(ARTIFACT_INPUT_MAX_BYTES - initialSize);
    expect(Buffer.byteLength(JSON.stringify({ data }))).toBeLessThan(
      ARTIFACT_INPUT_MAX_BYTES,
    );
    const exact = fixture(config, data);
    await exact.execute();
    expect(exact.bytes()).toHaveLength(ARTIFACT_INPUT_MAX_BYTES);
    last.value += 'x';
    const tooLarge = fixture(config, data);
    const failure = tooLarge.execute();
    await expect(failure).rejects.toMatchObject({
      safeErrorCode: 'file.create_size',
    });
    await expect(failure).rejects.toHaveProperty(
      'errorSummary',
      expect.stringContaining('split the data'),
    );
    expect(tooLarge.write).not.toHaveBeenCalled();
  });
  it('writes the maximum row count within the unchanged envelope', async () => {
    const state = fixture(
      csv,
      Array.from({ length: 4996 }, () => ({ amount: 1 })),
    );
    const started = performance.now();
    await state.execute();
    expect(state.bytes()).toHaveLength(24990);
    process.stdout.write(
      `Create file 4996 rows: ${String(Math.round(performance.now() - started))} ms, ${String(state.bytes().length)} bytes\n`,
    );
  });
  it('reports unavailable storage and releases owned chunks after a failed or canceled write', async () => {
    const unavailable = fixture({ format: 'text' }, 'private');
    const { artifacts: _artifacts, ...withoutStorage } = unavailable.runtime;
    await expect(
      registry.execute({
        definition: identity,
        executor: identity,
        config: { format: 'text' },
        input: { data: 'private' },
        signal: unavailable.controller.signal,
        runtime: withoutStorage,
      }),
    ).rejects.toMatchObject({ safeErrorCode: 'file.create_storage' });
    for (const canceled of [false, true]) {
      const state = fixture({ format: 'text' }, 'private');
      state.write.mockImplementation(async (input) => {
        for await (const chunk of input.body) state.chunks.push(chunk);
        if (canceled) state.controller.abort();
        throw new Error('synthetic storage failure');
      });
      const failed = state.execute();
      if (canceled)
        await expect(failed).rejects.toMatchObject({
          kind: 'canceled',
          possiblyDispatched: false,
        });
      else
        await expect(failed).rejects.toMatchObject({
          kind: 'retry',
          errorKind: 'network',
          possiblyDispatched: false,
          safeErrorCode: 'file.create_storage',
        });
      expect(
        state.chunks.every((chunk) => chunk.every((byte) => byte === 0)),
      ).toBe(true);
    }
  });
});
