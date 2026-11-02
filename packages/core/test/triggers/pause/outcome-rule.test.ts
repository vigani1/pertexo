import { describe, expect, it } from 'vitest';

import { streakOutcome } from '../../../src/triggers/pause/outcome-rule.js';

const finished = (status: string, triggerType = 'webhook') => ({
  triggerType,
  status,
  cancellationRequested: false,
});

describe('what a finished run means for the failure streak', () => {
  it.each(['failed', 'timed_out', 'outcome_unknown'])(
    'counts %s as a failure',
    (status) => {
      expect(streakOutcome(finished(status))).toBe('failure');
    },
  );

  it('resets on success', () => {
    expect(streakOutcome(finished('succeeded'))).toBe('success');
  });

  it.each(['canceled', 'running', 'queued'])('does not count %s', (status) => {
    expect(streakOutcome(finished(status))).toBe('not_counted');
  });

  it.each(['schedule', 'webhook', 'form'])('counts a %s run', (trigger) => {
    expect(streakOutcome(finished('failed', trigger))).toBe('failure');
  });

  it.each(['manual', 'api', 'replay'])('ignores a %s run', (trigger) => {
    expect(streakOutcome(finished('failed', trigger))).toBe('not_counted');
  });

  it('ignores a failure someone asked to cancel', () => {
    expect(
      streakOutcome({ ...finished('failed'), cancellationRequested: true }),
    ).toBe('not_counted');
  });
});
