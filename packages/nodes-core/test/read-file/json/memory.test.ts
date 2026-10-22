import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

function runProbe(kind: string) {
  const moduleUrl = new URL(
    '../../../dist/data/read-file/json/records.js',
    import.meta.url,
  ).href;
  const script = `
    import { setImmediate } from 'node:timers/promises';
    const { readJsonRecords } = await import(${JSON.stringify(moduleUrl)});
    const kind = ${JSON.stringify(kind)};
    let supplied = 0, count = 0;
    let high = process.memoryUsage();
    const sample = () => {
      const memory = process.memoryUsage();
      for (const key of Object.keys(memory)) high[key] = Math.max(high[key], memory[key]);
    };
    async function* source() {
      yield Buffer.from('[');
      if (kind === 'records' || kind === 'maximum') {
        const total = kind === 'records' ? 10000 : 100000;
        for (let index = 0; index < total; index += 1) {
          const row = Buffer.from((index === 0 ? '' : ',') + JSON.stringify({ id: index, text: 'a'.repeat(75) }));
          supplied += row.length;
          yield row;
          if (index % 1000 === 0) { sample(); await setImmediate(); }
        }
      } else if (kind === 'depth') {
        yield Buffer.from('['.repeat(1000000));
      } else if (kind === 'members') {
        yield Buffer.from('[' + '0,'.repeat(1000000));
      } else if (kind === 'wide') {
        yield Buffer.from('{');
        for (let index = 0; index < 4000; index += 1) {
          const part = Buffer.from((index ? ',' : '') + JSON.stringify('k' + index) + ':' + JSON.stringify('x'.repeat(32000)));
          supplied += part.length; yield part;
        }
      } else {
        yield Buffer.from(kind === 'number' ? '1e' : '"');
        for (let index = 0; index < 160; index += 1) {
          supplied += 65536;
          yield Buffer.alloc(65536, kind === 'number' ? 48 : 97);
          sample();
        }
      }
      yield Buffer.from(']');
    }
    let refused = false;
    try {
      for await (const value of readJsonRecords(source(), new AbortController().signal)) { count++; if(count % 1000===0) sample(); }
    } catch (error) {
      if (error.safeErrorCode !== 'execution.file_input') throw error;
      refused = true;
    }
    sample();
    console.log(JSON.stringify({count,refused,supplied,high}));
  `;
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '--input-type=module', '--eval', script],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 65536 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    count: number;
    refused: boolean;
    supplied: number;
    high: { rss: number; heapUsed: number; external: number };
  };
}

it('keeps 1 MiB and 10 MiB record parsing bounded instead of retaining the document', () => {
  const baseline = runProbe('records');
  const maximum = runProbe('maximum');
  expect(baseline.count).toBe(10000);
  expect(maximum.count).toBe(100000);
  expect(maximum.refused).toBe(false);
  expect(maximum.high.heapUsed).toBeLessThan(64 * 1024 * 1024);
  expect(maximum.high.external).toBeLessThan(8 * 1024 * 1024);
  console.info('F45 JSON parser baseline and maximum', { baseline, maximum });
  // Two child processes of up to 20 s each; the default 5 s fails whenever
  // other packages' tests share the machine, as they do before a push.
}, 60_000);

it.each(['number', 'string', 'depth', 'members', 'wide'])(
  'refuses hostile %s within a 64 MiB heap before constructing an oversized record',
  (kind) => {
    const result = runProbe(kind);
    expect(result.refused).toBe(true);
    expect(result.count).toBe(0);
    if (kind === 'number' || kind === 'string' || kind === 'wide')
      expect(result.supplied).toBeLessThan(512 * 1024);
  },
  30_000,
);
