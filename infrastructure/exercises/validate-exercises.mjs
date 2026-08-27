/* global URL, process */

import { readFile } from 'node:fs/promises';

import { parseProfile } from './run-http-exercise.mjs';

const expectedScenarios = new Set([
  'steady-run-start',
  'webhook-burst',
  'large-fan-out',
  'long-wait',
  'noisy-tenant-load',
  'noisy-tenant-control',
]);
const profileDirectory = new URL('./profiles/', import.meta.url);
const profileNames = [
  'api-steady.json',
  'webhook-burst.json',
  'large-fan-out.json',
  'long-wait.json',
  'noisy-tenant-load.json',
  'noisy-tenant-control.json',
];

for (const profileName of profileNames) {
  const profileUrl = new URL(profileName, profileDirectory);
  const bytes = await readFile(profileUrl, 'utf8');
  const profile = parseProfile(JSON.parse(bytes));
  if (!expectedScenarios.delete(profile.scenario))
    throw new Error(`${profileUrl.pathname}: duplicate or invalid scenario`);
  if (
    profile.authentication === 'webhook-hmac' &&
    profile.scenario !== 'webhook-burst'
  )
    throw new Error(
      `${profileUrl.pathname}: webhook authentication is scenario-specific`,
    );
}

if (expectedScenarios.size > 0)
  throw new Error(
    `Missing exercise scenarios: ${[...expectedScenarios].join(', ')}`,
  );

process.stdout.write(
  `Validated ${String(profileNames.length)} exercise profiles\n`,
);
