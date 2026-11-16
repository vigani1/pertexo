import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { faultProject } from './fault-project.mjs';

/** Longest first, placing each file on the least loaded shard. */
export function assignFaultShards(files, durations, count) {
  const recorded = Object.values(durations).sort((a, b) => a - b);
  const middle = Math.floor(recorded.length / 2);
  const median =
    recorded.length === 0
      ? 0
      : recorded.length % 2
        ? recorded[middle]
        : (recorded[middle - 1] + recorded[middle]) / 2;
  const duration = (file) => durations[file] ?? median;
  const shards = Array.from({ length: count }, () => ({
    files: [],
    milliseconds: 0,
  }));
  for (const file of [...files].sort(
    (a, b) => duration(b) - duration(a) || a.localeCompare(b),
  )) {
    const shard = shards.reduce((least, next) =>
      next.milliseconds < least.milliseconds ? next : least,
    );
    shard.files.push(file);
    shard.milliseconds += duration(file);
  }
  return shards;
}

function main([index, total]) {
  faultProject();
  const count = Number(total);
  const selected = Number(index);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(selected) ||
    selected < 1 ||
    selected > count
  )
    throw new Error('usage: run-fault-shard.mjs <1-based shard> <shard count>');
  const root = resolve(import.meta.dirname, '../../apps/worker');
  const directory = join(root, 'test/recovery');
  const files = readdirSync(directory, { recursive: true })
    .filter((file) => file.endsWith('.resilience.integration.test.ts'))
    .map((file) => 'test/recovery/' + file);
  const durations = JSON.parse(
    readFileSync(join(directory, 'durations.json'), 'utf8'),
  );
  const shard = assignFaultShards(files, durations, count)[selected - 1];
  console.log(JSON.stringify({ shard: selected, ...shard }));
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.resilience.config.ts',
      ...shard.files,
      '--reporter=default',
      '--reporter=' + resolve(import.meta.dirname, 'fault-durations.mjs'),
    ],
    {
      cwd: root,
      env: { ...process.env, WORKER_FAULT_TESTS: 'true' },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
