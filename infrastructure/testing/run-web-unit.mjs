import { spawnSync } from 'node:child_process';
import {
  WEB_UNIT_SHARD_COUNT,
  recordedWebUnitShards,
} from './web-unit-shards.mjs';

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
      ? [
          'related',
          ...files,
          '--run',
          '--passWithNoTests',
          ...(shard ? ['--shard', `${shard}/${WEB_UNIT_SHARD_COUNT}`] : []),
        ]
      : ['run', ...files]),
  ],
  { stdio: 'inherit', env: { ...process.env, TZ: 'Europe/Belgrade' } },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
