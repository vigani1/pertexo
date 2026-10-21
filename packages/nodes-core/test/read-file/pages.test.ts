import { describe, expect, it } from 'vitest';
import { filePageBundleSchema, FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import { createCoreNodeRegistry } from '../../src/server.js';
import { files } from './artifacts.fixture.js';

const registry = createCoreNodeRegistry();
function run(
  state: ReturnType<typeof files>,
  key: string,
  config: unknown,
  input: unknown,
  signal = new AbortController().signal,
) {
  const identity = { key: `core.${key}`, version: 1 };
  return registry.execute({
    definition: identity,
    executor: identity,
    config,
    input,
    signal,
    runtime: state.runtime,
  });
}
describe('explicit ordinary file pages', () => {
  it('pages 100,000 converted CSV rows, then streams one ordered JSON and CSV without changing inline limits', async () => {
    const state = files();
    const file = state.add(
      Buffer.from(
        'id,amount,currency\r\n' +
          Array.from(
            { length: 100000 },
            (_, id) => `${String(id)},12.5,EUR\r\n`,
          ).join(''),
      ),
    );
    expect(file.byteLength).toBeGreaterThan(1048576);
    await expect(
      run(state, 'read_file', { format: 'csv', delimiter: ',' }, { file }),
    ).rejects.toMatchObject({ diagnostic: { reason: 'inline_file_size' } });
    const result = await run(
      state,
      'read_file',
      { format: 'csv', delimiter: ',', outputMode: 'pages' },
      { file },
    );
    if (result.kind !== 'succeeded') throw Error('Read failed');
    const bundle = filePageBundleSchema.parse(result.output);
    expect(bundle.itemCount).toBe(100000);
    expect(bundle.pageCount).toBe(100);
    for (const page of bundle.pages) {
      expect(page.byteLength).toBeLessThanOrEqual(FILE_PAGE_LIMITS.bytes);
      expect(
        (JSON.parse(state.get(page.artifactId).toString()) as unknown[]).length,
      ).toBeLessThanOrEqual(1000);
    }
    const flattened = bundle.pages.flatMap(
      (page) => JSON.parse(state.get(page.artifactId).toString()) as unknown[],
    );
    expect(flattened[0]).toEqual({ id: 0, amount: 12.5, currency: 'EUR' });
    expect(flattened.at(-1)).toEqual({
      id: 99999,
      amount: 12.5,
      currency: 'EUR',
    });
    for (const format of ['json', 'csv']) {
      const created = await run(
        state,
        'create_file',
        {
          format,
          inputMode: 'pages',
          ...(format === 'csv'
            ? { delimiter: ',', columns: ['currency', 'id', 'amount'] }
            : {}),
        },
        { pages: bundle.pages },
      );
      if (created.kind !== 'succeeded') throw Error('Create failed');
      const ref = (created.output as { file: { artifactId: string } }).file;
      const bytes = state.get(ref.artifactId);
      expect(bytes.length).toBeGreaterThan(1048576);
      if (format === 'json')
        expect(JSON.parse(bytes.toString())).toEqual(flattened);
      else {
        const text = bytes.toString();
        expect(text.startsWith('"currency","id","amount"\r\n')).toBe(true);
        expect(text.endsWith('"EUR","99999","12.5"\r\n')).toBe(true);
        expect(text.split('"currency"')).toHaveLength(2);
      }
    }
    expect(state.release).toHaveBeenCalledOnce();
    expect(state.beforeDispatch).not.toHaveBeenCalled();
  }, 20000);
  it.each(['json', 'csv'])(
    'keeps empty %s pages empty and writes a valid empty file',
    async (format) => {
      const state = files();
      const file = state.add(Buffer.from(format === 'json' ? '[]' : 'id\r\n'));
      const output = await run(
        state,
        'read_file',
        {
          format,
          outputMode: 'pages',
          ...(format === 'csv' ? { delimiter: ',' } : {}),
        },
        { file },
      );
      expect(output).toMatchObject({
        kind: 'succeeded',
        output: { pages: [], itemCount: 0, pageCount: 0 },
      });
      const created = await run(
        state,
        'create_file',
        { format: 'json', inputMode: 'pages' },
        { pages: [] },
      );
      if (created.kind !== 'succeeded') throw Error('Create failed');
      expect(
        state.data
          .get(
            (created.output as { file: { artifactId: string } }).file
              .artifactId,
          )
          ?.toString(),
      ).toBe('[]');
    },
  );
  it('retains BOM, multiline quoting, conservative conversion and safe CSV cells across pages', async () => {
    const state = files();
    const file = state.add(
      Buffer.from(
        '\ufeffid;value;paid;amount\r\n00123;"line\nnext";true;12.5\r\n2;"=SUM(A1)";false;9\r\n',
      ),
    );
    const output = await run(
      state,
      'read_file',
      { format: 'csv', delimiter: ';', outputMode: 'pages' },
      { file },
    );
    if (output.kind !== 'succeeded') throw Error('Read failed');
    const bundle = filePageBundleSchema.parse(output.output);
    const rows: unknown = JSON.parse(
      state.get(bundle.pages[0]?.artifactId ?? '').toString(),
    );
    expect(rows).toEqual([
      { id: '00123', value: 'line\nnext', paid: true, amount: 12.5 },
      { id: 2, value: '=SUM(A1)', paid: false, amount: 9 },
    ]);
    const created = await run(
      state,
      'create_file',
      { format: 'csv', inputMode: 'pages', delimiter: ',', columns: ['value'] },
      { pages: bundle.pages },
    );
    if (created.kind !== 'succeeded') throw Error('Create failed');
    expect(
      state.data
        .get(
          (created.output as { file: { artifactId: string } }).file.artifactId,
        )
        ?.toString(),
    ).toContain('"\'=SUM(A1)"');
  });
  it.each(['[1,', '"' + 'x'.repeat(65536) + '"', '{"not":"an array"}'])(
    'never returns a bundle after malformed/oversized JSON',
    async (text) => {
      const state = files();
      const file = state.add(Buffer.from(text));
      await expect(
        run(
          state,
          'read_file',
          { format: 'json', outputMode: 'pages' },
          { file },
        ),
      ).rejects.toMatchObject({ possiblyDispatched: false });
      expect(state.release).toHaveBeenCalledOnce();
    },
  );
  it('does not return partial success on a late parser or page finalization failure', async () => {
    const state = files();
    const file = state.add(Buffer.from('[' + '0,'.repeat(3001) + ']'));
    await expect(
      run(
        state,
        'read_file',
        { format: 'json', outputMode: 'pages' },
        { file },
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'execution.file_input' });
    expect(state.write).toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
    state.write.mockRejectedValueOnce(new Error('storage unavailable'));
    const good = state.add(Buffer.from('[1]'));
    await expect(
      run(
        state,
        'read_file',
        { format: 'json', outputMode: 'pages' },
        { file: good },
      ),
    ).rejects.toThrow('storage unavailable');
    expect(state.release).toHaveBeenCalledTimes(2);
  });
  it('refuses malformed pages, non-object CSV rows and missing explicit CSV columns', async () => {
    const state = files();
    const page = state.add(Buffer.from('{"no":"array"}'));
    await expect(
      run(
        state,
        'create_file',
        { format: 'json', inputMode: 'pages' },
        { pages: [page] },
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'file.create_data' });
    const scalar = state.add(Buffer.from('[1]'));
    await expect(
      run(
        state,
        'create_file',
        { format: 'csv', inputMode: 'pages', delimiter: ',', columns: ['id'] },
        { pages: [scalar] },
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'file.create_data' });
    await expect(
      run(
        state,
        'create_file',
        { format: 'csv', inputMode: 'pages', delimiter: ',', columns: [] },
        { pages: [] },
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'file.create_columns' });
  });
});
