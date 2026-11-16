import { readFileSync, readdirSync } from 'node:fs';

export const browserReach = JSON.parse(
  readFileSync(new URL('./browser-reach.json', import.meta.url), 'utf8'),
);

export function validateBrowserReach(reach, specs, journeys, features) {
  const expected = new Set([
    ...specs,
    ...journeys.map((name) => `journey:${name}`),
  ]);
  const errors = [];
  for (const name of expected)
    if (!Object.hasOwn(reach, name)) errors.push(`Missing reach: ${name}`);
  for (const [name, entry] of Object.entries(reach)) {
    if (!expected.has(name)) errors.push(`Stale reach: ${name}`);
    if (entry === 'all') continue;
    if (!Array.isArray(entry) || entry.length === 0) {
      errors.push(`Empty reach: ${name}`);
      continue;
    }
    for (const feature of entry)
      if (!features.includes(feature))
        errors.push(`Unknown feature: ${feature}`);
  }
  return errors;
}

export function browserFeatures() {
  return readdirSync(new URL('../../apps/web/src/features', import.meta.url), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

const knownFeatures = browserFeatures();

export function selectBrowserReach(files, reach = browserReach) {
  const features = new Set();
  for (const file of files) {
    const match = /^apps\/web\/(?:src|test)\/features\/([^/]+)\//u.exec(file);
    if (!match || !knownFeatures.includes(match[1])) return undefined;
    features.add(match[1]);
  }
  return Object.entries(reach)
    .filter(
      ([, entry]) =>
        entry === 'all' || entry.some((name) => features.has(name)),
    )
    .map(([name]) => name);
}
