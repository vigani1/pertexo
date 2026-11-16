import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { faultProject } from './fault-project.mjs';

export { assignDurationShards as assignFaultShards } from './duration-shards.mjs';
import { assignDurationShards } from './duration-shards.mjs';

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
  const shard = assignDurationShards(files, durations, count)[selected - 1];
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
