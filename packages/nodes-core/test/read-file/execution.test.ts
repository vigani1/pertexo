import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FileInputFailure,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { createCoreNodeRegistry } from '../../src/server.js';

const identity = { key: 'core.read_file', version: 1 };
const signal = new AbortController().signal;
const registry = createCoreNodeRegistry();
function fixture(
  content: string | Uint8Array,
  config: unknown = { format: 'csv', delimiter: ',' },
  executionSignal = signal,
) {
  const bytes =
    typeof content === 'string'
      ? Buffer.from(content)
      : Uint8Array.from(content);
  const file = {
    kind: 'artifact',
    artifactId: '11111111-1111-4111-8111-111111111111',
    byteLength: bytes.length,
    mediaType: 'application/octet-stream',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const read = vi.fn().mockResolvedValue(bytes);
  const beforeDispatch = vi.fn();
  const runtime: NodeExecutionRuntime = {
    workspaceId: 'workspace',
    runId: 'run',
    nodeRunId: 'node-run',
    attemptId: 'attempt',
    attemptNumber: 1,
    nodeId: 'read',
    invocationKey: 'root',
    sideEffectClass: 'safe',
    beforeDispatch,
    artifacts: { read, write: vi.fn() },
  };
  return {
    bytes,
    file,
    read,
    beforeDispatch,
    execute: () =>
      registry.execute({
        definition: identity,
        executor: identity,
        config,
        input: { file },
        signal: executionSignal,
        runtime,
      }),
  };
}
async function output(content: string, config?: unknown) {
  const result = await fixture(content, config).execute();
  if (result.kind !== 'succeeded')
    throw new Error('Expected parsed file output');
  return result.output;
}

describe('Read file through the scoped runtime', () => {
  it('defaults conversion on, reads checked bytes without dispatch and releases them', async () => {
    const state = fixture(
      '\uFEFFcurrency,amount,paid\r\nEUR,12.5,true\r\nUSD,9,false\r\n',
    );
    expect(await state.execute()).toEqual({
      kind: 'succeeded',
      output: [
        { currency: 'EUR', amount: 12.5, paid: true },
        { currency: 'USD', amount: 9, paid: false },
      ],
    });
    expect(state.read).toHaveBeenCalledWith({
      reference: {
        artifactId: state.file.artifactId,
        byteLength: state.file.byteLength,
        mediaType: state.file.mediaType,
        sha256: state.file.sha256,
      },
      maxBytes: 1048576,
      signal,
    });
    expect(state.beforeDispatch).not.toHaveBeenCalled();
    expect(state.bytes.every((value) => value === 0)).toBe(true);
  });
  it.each([',', ';', '\t'])(
    'handles %j, multiline quoting, escaped quotes and empty records',
    async (delimiter) => {
      const csv = [
        'name' + delimiter + 'value',
        '',
        '"first\nsecond"' + delimiter + '"a""b"',
        '""' + delimiter,
        ' ' + delimiter + ' ',
      ].join('\r\n');
      expect(await output(csv, { format: 'csv', delimiter })).toEqual([
        { name: 'first\nsecond', value: 'a"b' },
        { name: '', value: '' },
        { name: ' ', value: ' ' },
      ]);
    },
  );
  it('converts only exact booleans and conservative JSON decimals', async () => {
    const cells = [
      'true',
      'false',
      '0',
      '-0',
      '12.5',
      '1e2',
      '00123',
      '9007199254740993',
      '1e999',
      ' TRUE',
      'true ',
      'null',
      '',
      '+1',
      '.5',
      '2026-10-15',
    ];
    expect(
      await output('v\n' + cells.map((v) => '"' + v + '"').join('\n')),
    ).toEqual(
      [true, false, 0, 0, 12.5, 100, ...cells.slice(6)].map((v) => ({ v })),
    );
    expect(
      await output('v\ntrue\n1', {
        format: 'csv',
        delimiter: ',',
        convertValues: false,
      }),
    ).toEqual([{ v: 'true' }, { v: '1' }]);
  });
  it('preserves unusual own keys and exact header whitespace without prototype mutation', async () => {
    const result = await output('__proto__,constructor, name \na,b,c');
    expect(JSON.stringify(result)).toBe(
      '[{"__proto__":"a","constructor":"b"," name ":"c"}]',
    );
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('accepts a header-only CSV, and keeps Unicode intact across chunk boundaries', async () => {
    expect(await output('a,b\r\n')).toEqual([]);
    const value = 'x'.repeat(4092) + '😀é';
    expect(await output('v\n' + value)).toEqual([{ v: value }]);
  });
  it.each([
    ['', 'csv_empty'],
    ['\n\r\n', 'csv_empty'],
    ['a,a\nx,y', 'duplicate_header'],
    ['a, \nx,y', 'blank_header'],
    ['a,b\nx', 'csv_columns'],
    ['a\nx,y', 'csv_columns'],
    ['a\n"open', 'csv_syntax'],
    ['a\nva"lue', 'csv_syntax'],
  ])(
    'rejects malformed CSV %# without retaining its content',
    async (csv, reason) => {
      await expect(fixture(csv).execute()).rejects.toMatchObject({
        diagnostic: { reason },
        kind: 'failed',
        possiblyDispatched: false,
      });
    },
  );
  it('returns JSON scalars and nested values directly, tolerating one UTF-8 BOM', async () => {
    for (const value of [null, true, 'text', 12, { rows: [{ amount: 2 }] }])
      expect(
        await output('\uFEFF' + JSON.stringify(value), { format: 'json' }),
      ).toEqual(value);
  });
  it.each([
    ['{"secret":"redaction-sentinel",}', 'json_syntax'],
    ['[1e999]', 'json_number'],
    ['['.repeat(65) + '0' + ']'.repeat(65), 'value_size'],
  ])(
    'rejects invalid or unrepresentable JSON %# with closed diagnostics',
    async (text, reason) => {
      try {
        await fixture(text, { format: 'json' }).execute();
        throw new Error('Expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(FileInputFailure);
        expect(error).toMatchObject({ diagnostic: { reason } });
        expect(JSON.stringify(error)).not.toContain('redaction-sentinel');
      }
    },
  );
  it('refuses invalid UTF-8 and oversized files before parsing, and zeroes failed bytes', async () => {
    const bad = fixture(new Uint8Array([255]));
    await expect(bad.execute()).rejects.toMatchObject({
      diagnostic: { reason: 'invalid_utf8' },
    });
    expect(bad.bytes[0]).toBe(0);
    const large = fixture(new Uint8Array(1048577));
    await expect(large.execute()).rejects.toMatchObject({
      diagnostic: { reason: 'inline_file_size' },
    });
    expect(large.read).not.toHaveBeenCalled();
  });
  it('accepts an exact 1 MiB JSON file and releases bytes if canceled after its read', async () => {
    const text = '"' + 'x'.repeat(1048574) + '"';
    expect((await output(text, { format: 'json' })) as string).toHaveLength(
      1048574,
    );
    const controller = new AbortController();
    const state = fixture('v\n1', undefined, controller.signal);
    state.read.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(state.bytes);
    });
    await expect(state.execute()).rejects.toMatchObject({
      kind: 'canceled',
      possiblyDispatched: false,
    });
    expect(state.bytes.every((value) => value === 0)).toBe(true);
  });
  it('bounds parsed expansion and nested JSON arrays', async () => {
    await expect(
      fixture('very_long_header\n' + 'x\n'.repeat(4998)).execute(),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    await expect(
      fixture('v\n' + 'x\n'.repeat(4999)).execute(),
    ).rejects.toMatchObject({ diagnostic: { reason: 'item_count' } });
    await expect(
      fixture(
        JSON.stringify({ items: Array.from({ length: 4999 }, () => 1) }),
        { format: 'json' },
      ).execute(),
    ).rejects.toMatchObject({ diagnostic: { reason: 'item_count' } });
    await expect(
      fixture('x'.repeat(250) + '\n' + 'a\n'.repeat(4500)).execute(),
    ).rejects.toMatchObject({ diagnostic: { reason: 'value_size' } });
  });
});
