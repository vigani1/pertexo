import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

function measure(size: number) {
  const moduleUrl = new URL(
    '../../../../dist/attempts/artifacts/scratch/space.js',
    import.meta.url,
  ).href;
  const script = `
    import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { Readable } from 'node:stream';
    import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
    const { ArtifactScratchSpace } = await import(${JSON.stringify(moduleUrl)});
    const size = ${String(size)};
    const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-scratch-load-'));
    const space = await ArtifactScratchSpace.create(directory);
    let high = process.memoryUsage();
    const sample = () => {
      const next = process.memoryUsage();
      for (const key of Object.keys(next)) high[key] = Math.max(high[key], next[key]);
    };
    const timer = setInterval(sample, 5);
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const started = performance.now();
    let files = [];
    try {
      files = await Promise.all(Array.from({length: 32}, (_, index) => {
        function* chunks() {
          for (let offset = 0; offset < size; offset += 65536)
            yield Buffer.alloc(Math.min(65536, size-offset), index);
        }
        return space.spool({attemptId:'attempt-'+index, maxBytes:size, body:Readable.from(chunks(), {objectMode:false, highWaterMark:65536}), signal:new AbortController().signal});
      }));
      let disk = 0;
      for (const name of await readdir(directory)) disk += (await stat(path.join(directory,name,'body'))).size;
      sample();
      const elapsedMillis = performance.now()-started;
      console.log(JSON.stringify({size, concurrency:32, disk, high, elapsedMillis, eventLoopP99Millis:delay.percentile(99)/1e6}));
    } finally {
      clearInterval(timer); delay.disable();
      await Promise.all(files.map(file=>file.release()));
      if ((await readdir(directory)).length !== 0) throw new Error('scratch cleanup incomplete');
      await rm(directory,{recursive:true});
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '--input-type=module', '--eval', script],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    disk: number;
    high: { heapUsed: number; external: number };
    eventLoopP99Millis: number;
  };
}

it('spools 32 concurrent maximum files to disk with bounded heap and external buffers', () => {
  const baseline = measure(1_048_576);
  const maximum = measure(10_485_760);
  expect(baseline.disk).toBe(32 * 1_048_576);
  expect(maximum.disk).toBe(32 * 10_485_760);
  expect(maximum.high.heapUsed).toBeLessThan(64 * 1024 * 1024);
  expect(maximum.high.external).toBeLessThan(64 * 1024 * 1024);
  console.info('F45 private scratch at default attempt concurrency', {
    baseline,
    maximum,
  });
});
