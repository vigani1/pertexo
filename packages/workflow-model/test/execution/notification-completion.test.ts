import { describe, expect, it } from 'vitest';
import { failureNotificationCompletionDecision } from '../../src/execution/notification-completion.js';
import { decideScheduleHealthTransition } from '../../src/triggers/schedules/health.js';

describe('failure notification completion decisions', () => {
  it('never retries an unsafe request after dispatch', () => {
    expect(
      failureNotificationCompletionDecision(
        {
          status: 'dispatching',
          side_effect_class: 'unsafe',
          possibly_dispatched: false,
        },
        {
          kind: 'retry',
          possiblyDispatched: true,
          safeErrorCode: 'provider.unavailable',
        },
        1,
        3,
      ),
    ).toEqual({
      kind: 'terminal',
      deliveryUnresolved: true,
      status: 'outcome_unknown',
    });
  });
  it('retries an unsafe request known not to have dispatched', () => {
    expect(
      failureNotificationCompletionDecision(
        {
          status: 'claimed',
          side_effect_class: 'unsafe',
          possibly_dispatched: false,
        },
        {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.unavailable',
        },
        1,
        3,
      ),
    ).toEqual({ kind: 'retry', deliveryUnresolved: false });
  });
  it('keeps unresolved idempotent delivery unknown when retries are exhausted', () => {
    expect(
      failureNotificationCompletionDecision(
        {
          status: 'claimed',
          side_effect_class: 'idempotent_with_key',
          possibly_dispatched: true,
        },
        {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.unavailable',
        },
        3,
        3,
      ),
    ).toEqual({
      kind: 'terminal',
      deliveryUnresolved: true,
      status: 'outcome_unknown',
    });
  });
  it('dead-letters a definite failure without dispatch evidence', () => {
    expect(
      failureNotificationCompletionDecision(
        {
          status: 'claimed',
          side_effect_class: 'safe',
          possibly_dispatched: false,
        },
        {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.unavailable',
        },
        3,
        3,
      ),
    ).toMatchObject({ kind: 'terminal', status: 'dead_letter' });
  });
});

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
