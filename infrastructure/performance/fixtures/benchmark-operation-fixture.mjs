import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers';

const OPERATION_MARKER = 'PERTEXO_Q11_OPERATION_V2=';

if (process.env.PERTEXO_BENCHMARK_SEED !== '42') process.exit(2);

const timeOrigin = performance.timeOrigin;
const startedAtUnixMs = timeOrigin + performance.now();
setTimeout(() => {
  const middleAtUnixMs = timeOrigin + performance.now();
  process.stdout.write(
    `${OPERATION_MARKER}${JSON.stringify({
      schemaVersion: 2,
      name: 'fixture-first',
      startedAtUnixMs,
      endedAtUnixMs: middleAtUnixMs,
      population: 1,
      boundary: 'first fixture boundary',
    })}\n`,
  );
  process.stdout.write(
    `${OPERATION_MARKER}${JSON.stringify({
      schemaVersion: 2,
      name: 'fixture-second',
      startedAtUnixMs: middleAtUnixMs,
      endedAtUnixMs: timeOrigin + performance.now() + 7.5,
      population: 1,
      boundary: 'second fixture boundary',
    })}\n`,
  );
}, 120);
