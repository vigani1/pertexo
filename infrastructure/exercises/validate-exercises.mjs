/* global URL, process */

import { readFile } from 'node:fs/promises';

const profiles = [
  new URL('./profiles/api-steady.json', import.meta.url),
  new URL('./profiles/api-burst.json', import.meta.url),
];

for (const profileUrl of profiles) {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  if (profile.schemaVersion !== 1)
    throw new Error(`${profileUrl.pathname}: unsupported schema`);
  if (
    !Number.isInteger(profile.requestsPerSecond) ||
    profile.requestsPerSecond < 1
  )
    throw new Error(`${profileUrl.pathname}: invalid rate`);
  if (!Number.isInteger(profile.durationSeconds) || profile.durationSeconds < 1)
    throw new Error(`${profileUrl.pathname}: invalid duration`);
  if (profile.method !== 'POST')
    throw new Error(`${profileUrl.pathname}: unsafe method`);
  if (JSON.stringify(profile).match(/authorization|token|secret/iu))
    throw new Error(
      `${profileUrl.pathname}: profile may not contain credentials`,
    );
}

process.stdout.write(
  `Validated ${String(profiles.length)} exercise profiles\n`,
);
