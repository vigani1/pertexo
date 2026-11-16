import { spawnSync } from 'node:child_process';
import { recordedWebUnitShards } from './web-unit-shards.mjs';

const related = process.env.WEB_UNIT_RELATED;
const shard = process.argv[2];
const files = related
  ? JSON.parse(related)
  : recordedWebUnitShards()[Number(shard) - 1].files;
console.log(
  JSON.stringify({ mode: related ? 'related' : 'full', shard, files }),
);
const result = spawnSync(
  'pnpm',
  [
    '--filter',
    '@pertexo/web',
    'exec',
    'vitest',
    ...(related
      ? ['related', ...files, '--run', '--passWithNoTests']
      : ['run', ...files]),
  ],
  { stdio: 'inherit', env: { ...process.env, TZ: 'Europe/Belgrade' } },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
