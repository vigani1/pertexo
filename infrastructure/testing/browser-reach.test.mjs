import { browserEntries } from '../ci/select-jobs.mjs';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  browserFeatures,
  browserReach,
  validateBrowserReach,
} from './browser-reach.mjs';

const specs = readdirSync('apps/web/e2e', { recursive: true })
  .filter((file) => file.endsWith('.spec.ts'))
  .map((file) => `e2e/${file}`);
const journeys = browserEntries
  .filter(({ suite }) => suite.startsWith('live'))
  .flatMap(({ journeys }) => journeys.split(' '));
test('every spec and journey has valid reach with no stale entries', () => {
  assert.deepEqual(
    validateBrowserReach(browserReach, specs, journeys, browserFeatures()),
    [],
  );
});
test('missing, stale and unknown feature entries fail the check', () => {
  assert.deepEqual(
    validateBrowserReach({ old: ['missing'] }, ['new'], [], []),
    ['Missing reach: new', 'Stale reach: old', 'Unknown feature: missing'],
  );
});
