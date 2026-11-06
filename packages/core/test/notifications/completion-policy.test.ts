import { describe, expect, it } from 'vitest';
import { failureNotificationCompletionDecision } from '../../src/notifications/delivery/completion-policy.js';

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
