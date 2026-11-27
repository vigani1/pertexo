import { describe, expect, it } from 'vitest';
import {
  positionInWindow,
  upcomingRuns,
} from '@/features/workflow-settings/model/triggers/upcoming';
import { shortChecksum } from '@/features/workflow-settings/model/versions/history';

const now = Date.parse('2026-11-27T12:00:00.000Z');
const hours = (count: number) =>
  new Date(now + count * 3_600_000).toISOString();

describe('the next 24 hours of schedule runs', () => {
  it('keeps only runs inside the window, soonest first, across schedules', () => {
    expect(
      upcomingRuns(
        [
          { triggerId: 'a', name: 'Nightly', times: [hours(20), hours(44)] },
          { triggerId: 'b', name: 'Hourly', times: [hours(-1), hours(1)] },
        ],
        now,
      ),
    ).toEqual([
      { triggerId: 'b', name: 'Hourly', scheduledAt: hours(1) },
      { triggerId: 'a', name: 'Nightly', scheduledAt: hours(20) },
    ]);
  });

  it('places a run along the window and clamps what falls outside', () => {
    expect(positionInWindow(hours(6), now)).toBe(0.25);
    expect(positionInWindow(hours(30), now)).toBe(1);
    expect(positionInWindow(hours(-2), now)).toBe(0);
  });
});

it('shortens a version checksum to three groups of four', () => {
  expect(shortChecksum(`wf:sha256:v2:9c1e44ab07f2${'a'.repeat(52)}`)).toBe(
    '9c1e·44ab·07f2',
  );
  expect(shortChecksum(`wf:sha256:${'b'.repeat(64)}`)).toBe('bbbb·bbbb·bbbb');
});
