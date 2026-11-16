import { browserEntries } from '../ci/select-jobs.mjs';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  browserFeatures,
  browserReach,
  validateBrowserReach,
  selectBrowserReach,
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
test('a feature change selects its own reach and cross-feature tests', () => {
  assert.deepEqual(
    selectBrowserReach(['apps/web/src/features/usage/pages/usage.tsx'], {
      usage: ['usage'],
      editor: ['workflow-editor'],
      shared: 'all',
    }),
    ['usage', 'shared'],
  );
});
