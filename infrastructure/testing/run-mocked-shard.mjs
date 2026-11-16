import { spawnSync } from 'node:child_process';
import { mockedFilePatterns, recordedMockedShards } from './mocked-shards.mjs';

const index = Number(process.argv[2]?.split('/')[0]);
const shards = recordedMockedShards();
if (!Number.isInteger(index) || index < 1 || index > shards.length)
  throw new Error(`usage: run-mocked-shard.mjs <1-${shards.length}>`);
const shard = shards[index - 1];
console.log(JSON.stringify({ shard: index, ...shard }));
const patterns = mockedFilePatterns(shard.files);
const result = spawnSync(
  'pnpm',
  [
    '--filter',
    '@pertexo/web',
    'test:e2e',
    ...patterns,
    '--workers=3',
    '--reporter=list',
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
