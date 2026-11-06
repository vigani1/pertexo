import { describe, expect, it } from 'vitest';
import { decideScheduleHealthTransition } from '../../../src/triggers/schedules/management/schedule-health.js';

describe('schedule health decisions', () => {
  const observed = new Date('2026-01-01T00:00:00Z');
  const target = {
    next_fire_at: observed,
    status: 'disabled',
    misfire_policy: 'skip',
    admission_deferred_until: null,
    observed_at: observed,
  };
  it('resumes a skipped schedule at the next future recurrence', () => {
    const next = new Date('2026-01-01T01:00:00Z');
    expect(
      decideScheduleHealthTransition({ enabled: true }, target, () => next),
    ).toMatchObject({
      nextFireAt: next,
      healthStatus: 'healthy',
      triggerStatus: 'active',
    });
  });
  it('retains admission backoff when enabling', () => {
    expect(
      decideScheduleHealthTransition(
        { enabled: true },
        {
          ...target,
          admission_deferred_until: new Date('2026-01-01T00:10:00Z'),
        },
        () => observed,
      ),
    ).toMatchObject({
      healthStatus: 'degraded',
      lastErrorCode: 'schedule.admission_throttled',
    });
  });
  it('does not advance recurrence while disabling', () => {
    expect(
      decideScheduleHealthTransition({ enabled: false }, target, () => {
        throw new Error('must not advance');
      }),
    ).toMatchObject({
      nextFireAt: observed,
      healthStatus: 'disabled',
      triggerStatus: 'disabled',
    });
  });
});
