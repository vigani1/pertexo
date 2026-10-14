import { describe, expect, it } from 'vitest';
import { createCoreNodeRegistry } from '../../src/server.js';

const registry = createCoreNodeRegistry();
const signal = new AbortController().signal;
const run = (
  key: string,
  config: unknown,
  input: unknown,
  abortSignal = signal,
) =>
  registry.execute({
    definition: { key: `core.${key}`, version: 1 },
    executor: { key: `core.${key}`, version: 1 },
    config,
    input,
    signal: abortSignal,
  });
const filter = (operator = 'equals', path = '$') => ({ operator, path });
const sort = (
  direction = 'ascending',
  missing = 'last',
  valueType = 'number',
  path = '$',
) => ({ direction, missing, valueType, path });

describe('bounded collection execution', () => {
  it.each([
    ['contains', 1],
    ['less_than', '1'],
    ['greater_or_equal', null],
  ])(
    'requires a correctly typed %s operand even without selected values',
    async (operator, value) => {
      for (const items of [[], [{}]])
        await expect(
          run('filter', filter(operator, '$.x'), { items, value }),
        ).rejects.toMatchObject({ code: 'invalid_input' });
    },
  );
  it('filters strict scalar values without coercion and preserves their order', async () => {
    expect(
      await run('filter', filter(), {
        items: [1, '1', true, null, 1],
        value: 1,
      }),
    ).toEqual({
      kind: 'succeeded',
      output: { items: [1, 1], inputCount: 5, removedCount: 3 },
    });
    expect(
      await run('filter', filter('not_equals', '$.id'), {
        items: [{ id: 1 }, {}, { id: null }, { id: '1' }],
        value: 1,
      }),
    ).toEqual({
      kind: 'succeeded',
      output: {
        items: [{ id: null }, { id: '1' }],
        inputCount: 4,
        removedCount: 2,
      },
    });
  });
  it.each([
    'less_than',
    'less_or_equal',
    'greater_than',
    'greater_or_equal',
  ] as const)('applies numeric %s without coercion', async (operator) => {
    const expected = {
      less_than: [-2, 0],
      less_or_equal: [-2, 0, 2],
      greater_than: [4],
      greater_or_equal: [2, 4],
    };
    const result = await run('filter', filter(operator), {
      items: [-2, 0, 2, 4],
      value: 2,
    });
    expect(result).toMatchObject({
      kind: 'succeeded',
      output: { items: expected[operator] },
    });
    await expect(
      run('filter', filter(operator), { items: ['2'], value: 2 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('distinguishes own missing fields, null and an inherited-looking field name', async () => {
    const items = [{ x: null }, {}, { x: false }, { x: {} }];
    expect(
      await run('filter', filter('exists', '$.x'), { items }),
    ).toMatchObject({ output: { items: [items[0], items[2], items[3]] } });
    expect(
      await run('filter', filter('not_exists', '$.x'), { items }),
    ).toMatchObject({ output: { items: [{}] } });
    expect(
      await run('filter', filter('not_exists', '$.constructor'), {
        items: [{}],
      }),
    ).toMatchObject({ output: { items: [{}] } });
    expect(
      await run('filter', filter('equals', '$.x'), {
        items: [{ x: null }, {}],
        value: null,
      }),
    ).toMatchObject({ output: { items: [{ x: null }] } });
  });
  it('uses case-sensitive contains and refuses bad comparisons, even for an empty collection', async () => {
    expect(
      await run('filter', filter('contains'), {
        items: ['Alpha', 'alpha', 'betalpha'],
        value: 'al',
      }),
    ).toMatchObject({ output: { items: ['alpha', 'betalpha'] } });
    await expect(run('filter', filter(), { items: [] })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      run('filter', filter('contains'), { items: [1], value: '1' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      run('filter', filter(), { items: [{}], value: null }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it.each(['ascending', 'descending'])(
    'sorts stably %s with a direction-independent missing bucket',
    async (direction) => {
      const items = [
        { id: 'two-a', n: 2 },
        { id: 'absent' },
        { id: 'one', n: 1 },
        { id: 'null', n: null },
        { id: 'two-b', n: 2 },
      ];
      const numeric =
        direction === 'ascending'
          ? [items[2], items[0], items[4]]
          : [items[0], items[4], items[2]];
      expect(
        await run('sort', sort(direction, 'last', 'number', '$.n'), { items }),
      ).toMatchObject({
        output: { items: [...numeric, items[1], items[3]], inputCount: 5 },
      });
      expect(
        await run('sort', sort(direction, 'first', 'number', '$.n'), { items }),
      ).toMatchObject({ output: { items: [items[1], items[3], ...numeric] } });
    },
  );
  it('sorts text by code units, not the host locale, and rejects mixed keys', async () => {
    expect(
      await run('sort', sort('ascending', 'last', 'text'), {
        items: ['ä', 'z', 'A', 'a', 'Z'],
      }),
    ).toMatchObject({ output: { items: ['A', 'Z', 'a', 'z', 'ä'] } });
    await expect(
      run('sort', sort(), { items: [1, '2'] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(
      await run('sort', sort(), {
        items: [Number.MAX_VALUE, -Number.MAX_VALUE],
      }),
    ).toMatchObject({
      output: { items: [-Number.MAX_VALUE, Number.MAX_VALUE] },
    });
  });
  it('keeps first canonical whole-value duplicates without equating arrays or scalar types', async () => {
    const items = [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
      [1, 2],
      [2, 1],
      1,
      '1',
      null,
      null,
      -0,
      0,
    ];
    const before = structuredClone(items);
    expect(
      await run('unique', { path: '$', missing: 'error' }, { items }),
    ).toEqual({
      kind: 'succeeded',
      output: {
        items: [{ a: 1, b: 2 }, [1, 2], [2, 1], 1, '1', null, 0],
        inputCount: 10,
        duplicateCount: 3,
        skippedCount: 0,
      },
    });
    expect(items).toEqual(before);
  });
  it('counts duplicate and explicitly skipped missing keys separately', async () => {
    const items = [
      { id: 1, name: 'first' },
      {},
      { id: 1, name: 'second' },
      { id: null },
      { id: null },
      { id: '1' },
    ];
    await expect(
      run('unique', { path: '$.id', missing: 'error' }, { items }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(
      await run('unique', { path: '$.id', missing: 'skip' }, { items }),
    ).toMatchObject({
      output: {
        items: [items[0], items[3], items[5]],
        inputCount: 6,
        duplicateCount: 2,
        skippedCount: 1,
      },
    });
  });
  it('summarizes ordered scalar groups without coercing their identities', async () => {
    const items = [
      { g: 'b', n: 4 },
      { g: 'a', n: -2 },
      { g: 'b', n: 2 },
      { g: 1, n: 0 },
      { g: '1', n: 1 },
      { g: null, n: 5 },
    ];
    expect(
      await run(
        'summarize',
        { valuePath: '$.n', groupBy: '$.g', missing: 'error' },
        { items },
      ),
    ).toEqual({
      kind: 'succeeded',
      output: {
        inputCount: 6,
        skippedCount: 0,
        groups: [
          { key: 'b', count: 2, sum: 6, min: 2, max: 4, average: 3 },
          { key: 'a', count: 1, sum: -2, min: -2, max: -2, average: -2 },
          { key: 1, count: 1, sum: 0, min: 0, max: 0, average: 0 },
          { key: '1', count: 1, sum: 1, min: 1, max: 1, average: 1 },
          { key: null, count: 1, sum: 5, min: 5, max: 5, average: 5 },
        ],
      },
    });
  });
  it('makes empty summaries explicit and skips only missing/null data', async () => {
    expect(
      await run(
        'summarize',
        { valuePath: '$', missing: 'error' },
        { items: [] },
      ),
    ).toMatchObject({
      output: {
        groups: [
          { key: null, count: 0, sum: 0, min: null, max: null, average: null },
        ],
        inputCount: 0,
        skippedCount: 0,
      },
    });
    expect(
      await run(
        'summarize',
        { valuePath: '$.n', groupBy: '$.g', missing: 'error' },
        { items: [] },
      ),
    ).toMatchObject({ output: { groups: [] } });
    expect(
      await run(
        'summarize',
        { valuePath: '$', missing: 'skip' },
        { items: [null, 0, 2] },
      ),
    ).toMatchObject({
      output: { skippedCount: 1, groups: [{ count: 2, sum: 2, average: 1 }] },
    });
    for (const items of [[{ g: {}, n: null }], [{ n: '3' }], [{ g: [], n: 1 }]])
      await expect(
        run(
          'summarize',
          { valuePath: '$.n', groupBy: '$.g', missing: 'skip' },
          { items },
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      run('summarize', { valuePath: '$', missing: 'error' }, { items: [null] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('keeps decimal arithmetic explicit and refuses unsafe integer operands and sums', async () => {
    expect(
      await run(
        'summarize',
        { valuePath: '$', missing: 'error' },
        { items: [0.1, 0.2] },
      ),
    ).toMatchObject({
      output: {
        groups: [{ sum: 0.30000000000000004, average: 0.15000000000000002 }],
      },
    });
    for (const items of [
      [Number.MAX_SAFE_INTEGER + 1],
      [Number.MAX_SAFE_INTEGER, 1],
    ])
      await expect(
        run('summarize', { valuePath: '$', missing: 'error' }, { items }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it.each(['filter', 'sort', 'unique', 'summarize'])(
    'admits exactly 4998 %s items and rejects one over without changing global JSON bounds',
    async (key) => {
      const config =
        key === 'filter'
          ? filter('exists')
          : key === 'sort'
            ? sort()
            : key === 'unique'
              ? { path: '$', missing: 'error' }
              : { valuePath: '$', missing: 'error' };
      const items = Array.from({ length: 4998 }, (_, i) => i);
      expect(await run(key, config, { items })).toMatchObject({
        kind: 'succeeded',
      });
      await expect(
        run(key, config, { items: [...items, 4998] }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(run(key, config, { items: null })).rejects.toMatchObject({
        code: 'invalid_input',
      });
      await expect(
        run(key, config, { items: ['x'.repeat(1_048_576)] }),
      ).rejects.toMatchObject({ code: 'invalid_json' });
    },
  );
  it('rejects unsupported/deep/oversized paths and aborts before processing', async () => {
    for (const path of [
      '$.items[*]',
      '$..x',
      '$' + '.x'.repeat(65),
      "$['" + 'ä'.repeat(256) + "']",
    ])
      await expect(
        run('unique', { path, missing: 'error' }, { items: [] }),
      ).rejects.toMatchObject({ code: 'invalid_config' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      run('sort', sort(), { items: [2, 1] }, controller.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});
