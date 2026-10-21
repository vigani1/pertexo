import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createCoreNodeRegistry } from '../../src/server.js';
import { parseCsvFile } from '../../src/data/read-file/csv/inline.js';

const registry = createCoreNodeRegistry();
const signal = new AbortController().signal;
function run(key: string, config: unknown, input: unknown) {
  const identity = { key: `core.${key}`, version: 1 };
  return registry.execute({
    definition: identity,
    executor: identity,
    config,
    input,
    signal,
  });
}
describe('Read file feeds ordinary list operations within unchanged limits', () => {
  it('summarizes a default-converted currency export after filtering paid rows', async () => {
    const items = await parseCsvFile(
      'currency,amount,paid\nEUR,12.5,true\nEUR,7.5,true\nUSD,9,true\nEUR,100,false',
      { format: 'csv', delimiter: ',', convertValues: true },
      signal,
    );
    const filtered = await run(
      'filter',
      { path: '$.paid', operator: 'equals' },
      { items, value: true },
    );
    if (filtered.kind !== 'succeeded') throw new Error('Filter failed');
    const summary = await run(
      'summarize',
      { valuePath: '$.amount', groupBy: '$.currency', missing: 'error' },
      { items: (filtered.output as { items: unknown }).items },
    );
    expect(summary).toMatchObject({
      kind: 'succeeded',
      output: {
        inputCount: 3,
        skippedCount: 0,
        groups: [
          { key: 'EUR', count: 2, sum: 20 },
          { key: 'USD', count: 1, sum: 9 },
        ],
      },
    });
  });
  it('measures 4,996 narrow numeric rows through Read, Filter, Summarize and Stop without relaxing the envelope', async () => {
    const start = performance.now();
    const items = await parseCsvFile(
      'amount\n' + '1\n'.repeat(4996),
      { format: 'csv', delimiter: ',', convertValues: true },
      signal,
    );
    const filtered = await run(
      'filter',
      { path: '$.amount', operator: 'equals' },
      { items, value: 1 },
    );
    if (filtered.kind !== 'succeeded') throw new Error('Filter failed');
    const summary = await run(
      'summarize',
      { valuePath: '$.amount', missing: 'error' },
      { items: (filtered.output as { items: unknown }).items },
    );
    if (summary.kind !== 'succeeded') throw new Error('Summary failed');
    expect(await run('terminate', {}, summary.output)).toMatchObject({
      kind: 'terminal_success',
      output: { groups: [{ count: 4996, sum: 4996 }] },
    });
    process.stdout.write(
      `Read file 4996-row list pipeline: ${String(Math.round(performance.now() - start))} ms\n`,
    );
    const larger = await parseCsvFile(
      'amount\n' + '1\n'.repeat(4997),
      { format: 'csv', delimiter: ',', convertValues: true },
      signal,
    );
    await expect(
      run(
        'filter',
        { path: '$.amount', operator: 'equals' },
        { items: larger, value: 1 },
      ),
    ).rejects.toMatchObject({ code: 'invalid_json' });
  });
});
