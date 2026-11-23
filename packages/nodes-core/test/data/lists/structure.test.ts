import { describe, expect, it } from 'vitest';
import { createInlineNodeRegistry } from '@pertexo/node-sdk/server';
import { CORE_NODE_CATALOG } from '../../../src/index.js';
import {
  CORE_NODE_DEFINITION_REGISTRATIONS,
  CORE_NODE_EXECUTOR_REGISTRATIONS,
  createCoreNodeRegistry,
} from '../../../src/server.js';
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
describe('bounded list structure operations', () => {
  it('batches in order, retains the last partial batch, and never mutates items', async () => {
    const input = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    expect(await run('batch', { size: 2 }, input)).toEqual({
      kind: 'succeeded',
      output: {
        batches: [[{ id: 1 }, { id: 2 }], [{ id: 3 }]],
        inputCount: 3,
        batchCount: 2,
      },
    });
    expect(input).toEqual({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(await run('batch', { size: 5 }, { items: [] })).toMatchObject({
      output: { batches: [], inputCount: 0, batchCount: 0 },
    });
  });
  it.each([0, 2, 5])(
    'takes a prefix of %i and reports removed items',
    async (count) => {
      const kept = Math.min(count, 3);
      expect(await run('take', { count }, { items: [1, 2, 3] })).toEqual({
        kind: 'succeeded',
        output: {
          items: [1, 2, 3].slice(0, kept),
          inputCount: 3,
          removedCount: 3 - kept,
        },
      });
    },
  );
  it.each([
    [
      'batch',
      { size: 1 },
      { items: Array.from({ length: 4998 }, (_, i) => i) },
    ],
    [
      'take',
      { count: 4998 },
      { items: Array.from({ length: 4998 }, (_, i) => i) },
    ],
    [
      'concat',
      {},
      {
        items: Array.from({ length: 2499 }, (_, i) => i),
        otherItems: Array.from({ length: 2499 }, (_, i) => i + 2499),
      },
    ],
  ])(
    'executes %s at the new maximum under the existing envelope',
    async (key, config, input) => {
      const result = await run(key, config, input);
      expect(result).toMatchObject({
        kind: 'succeeded',
        output: { inputCount: 4998 },
      });
    },
  );
  it('admits the same Take v2 requests inline and through delivery at the member limit', async () => {
    const inline = createInlineNodeRegistry({
      catalog: CORE_NODE_CATALOG,
      definitions: [],
      executors: [],
      core: {
        definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
        executors: CORE_NODE_EXECUTOR_REGISTRATIONS,
      },
    });
    const pin = { key: 'core.take', version: 2 };
    const request = {
      definition: pin,
      executor: pin,
      config: { count: 0 },
      input: {
        items: Array.from({ length: 4998 }, (_, index) => ({ index })),
      },
    };
    const delivery = {
      signal: new AbortController().signal,
      connectionRefs: {},
    };
    await expect(
      registry.execute({ ...request, ...delivery }),
    ).rejects.toMatchObject({
      code: 'invalid_json',
    });
    expect(() => inline.executeInline({ ...request, now: 0 })).toThrow(
      expect.objectContaining({ code: 'invalid_json' }),
    );

    const fits = {
      ...request,
      input: { items: [0, ...request.input.items.slice(1)] },
    };
    const expected = {
      kind: 'succeeded',
      output: { items: [], inputCount: 4998, removedCount: 4998 },
    };
    await expect(registry.execute({ ...fits, ...delivery })).resolves.toEqual(
      expected,
    );
    expect(inline.executeInline({ ...fits, now: 0 })).toEqual(expected);
  });
  it('refuses combined overflow, invalid sizes and malformed lists', async () => {
    for (const [key, config, input, code] of [
      ['batch', { size: 0 }, { items: [] }, 'invalid_config'],
      ['batch', { size: 1.5 }, { items: [] }, 'invalid_config'],
      ['batch', { size: 4999 }, { items: [] }, 'invalid_config'],
      ['take', { count: -1 }, { items: [] }, 'invalid_config'],
      ['take', { count: 0.5 }, { items: [] }, 'invalid_config'],
      [
        'concat',
        {},
        { items: Array.from({ length: 4998 }, () => 0), otherItems: [1] },
        'invalid_input',
      ],
      ['concat', {}, { items: [], otherItems: null }, 'invalid_input'],
      ['batch', { size: 1 }, { items: undefined }, 'invalid_json'],
    ] as const)
      await expect(run(key, config, input)).rejects.toMatchObject({
        code,
      });
  });
  it('preserves global member and byte bounds for complex data and grouped outputs', async () => {
    await expect(
      run(
        'batch',
        { size: 1 },
        { items: Array.from({ length: 4998 }, () => ({ a: 1, b: 2 })) },
      ),
    ).rejects.toMatchObject({ code: 'invalid_json' });
    await expect(
      run('take', { count: 1 }, { items: ['x'.repeat(1_048_576)] }),
    ).rejects.toMatchObject({ code: 'invalid_json' });
    await expect(
      run(
        'summarize',
        { valuePath: '$', groupBy: '$', missing: 'error' },
        { items: Array.from({ length: 4998 }, (_, i) => i) },
      ),
    ).rejects.toThrow();
  });
  it.each(['batch', 'take', 'concat'])(
    'cancels %s before processing',
    async (key) => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        run(
          key,
          structureConfig(key),
          { items: [], ...(key === 'concat' ? { otherItems: [] } : {}) },
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: 'aborted' });
    },
  );
});

function structureConfig(key: string) {
  if (key === 'batch') return { size: 1 };
  if (key === 'take') return { count: 1 };
  return {};
}
