import { describe, expect, it } from 'vitest';

import {
  IDEMPOTENCY_STATUS,
  IDEMPOTENCY_STATUS_VALUES,
  RUN_STATUS,
  RUN_STATUS_VALUES,
} from '../src/execution-acceptance.js';

describe('execution vocabulary', () => {
  it('exports the authoritative workflow-run statuses', () => {
    expect(RUN_STATUS).toEqual({
      canceled: 'canceled',
      failed: 'failed',
      outcomeUnknown: 'outcome_unknown',
      queued: 'queued',
      running: 'running',
      succeeded: 'succeeded',
      timedOut: 'timed_out',
      waiting: 'waiting',
    });
    expect(RUN_STATUS_VALUES).toEqual([
      'queued',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ]);
  });

  it('exports the authoritative active idempotency statuses', () => {
    expect(IDEMPOTENCY_STATUS).toEqual({
      completed: 'completed',
      failed: 'failed',
      inProgress: 'in_progress',
    });
    expect(IDEMPOTENCY_STATUS_VALUES).toEqual([
      'in_progress',
      'completed',
      'failed',
    ]);
  });
});
