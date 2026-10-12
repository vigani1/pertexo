import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseRecoveryPoint,
  expiredRecoveryPoints,
} from '../backup/recovery-points.mjs';

test('accepts a real UTC point and rejects traversal, rollover and malformed dates', () => {
  assert.equal(
    parseRecoveryPoint('20261013T030000Z').time,
    Date.parse('2026-10-13T03:00:00Z'),
  );
  for (const value of [
    '../../x',
    '20260230T030000Z',
    '20261013T250000Z',
    '20261013',
    '20261013T030000Z/',
  ])
    assert.throws(() => parseRecoveryPoint(value));
});
test('retention removes only known prefixes older than 14 days, independent of object ages', () => {
  const now = Date.parse('2026-10-13T03:00:00Z');
  const listing = [
    'pertexo-beta/20260928T030000Z/',
    'pertexo-beta/20260929T030000Z/',
    'pertexo-beta/20261013T030000Z/',
    'other/20260928T030000Z/',
    'pertexo-beta/20260230T030000Z/',
    'pertexo-beta/20260928T030000Z/objects/',
  ].join('\n');
  assert.deepEqual(expiredRecoveryPoints(listing, now), [
    'pertexo-beta/20260928T030000Z',
  ]);
});
