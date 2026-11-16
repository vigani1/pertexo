import { readFileSync, readdirSync } from 'node:fs';
import { assignDurationShards } from './duration-shards.mjs';

export const WEB_UNIT_SHARD_COUNT = 2;

export function recordedWebUnitShards() {
  const files = readdirSync(new URL('../../apps/web/test', import.meta.url), {
    recursive: true,
  })
    .filter((file) => /\.test\.tsx?$/u.test(file))
    .map((file) => `test/${file}`);
  const durations = JSON.parse(
    readFileSync(new URL('./unit-durations.json', import.meta.url), 'utf8'),
  );
  return assignDurationShards(files, durations, WEB_UNIT_SHARD_COUNT);
}
