import { describe, expect, it } from 'vitest';
import { timedOutOutput } from '../../../src/runs/pending-tasks/lifecycle/expiry.js';
import {
  humanWaitClockRunning,
  humanWaitQuiescent,
} from '../../../src/runs/pending-tasks/lifecycle/human-wait-state.js';

const expired = {
  context: {},
  created_at: new Date('2026-11-15T09:00:00.000Z'),
  expires_at: new Date('2026-11-15T10:00:00.000Z'),
};

describe('pending task expiry', () => {
  it('leaves a timed-out output when the approval continues on Timed out', () => {
    const output = timedOutOutput({
      ...expired,
      kind: 'approval',
      config: { onExpiry: 'continue' },
    });
    expect(output).toBeDefined();
  });

  it('leaves none when the step fails its Wait, which is the default', () => {
    expect(
      timedOutOutput({ ...expired, kind: 'approval', config: {} }),
    ).toBeUndefined();
    expect(
      timedOutOutput({
        ...expired,
        kind: 'approval',
        config: { onExpiry: 'fail' },
      }),
    ).toBeUndefined();
  });

  it('leaves none for a callback, which has no Timed out path', () => {
    expect(
      timedOutOutput({ ...expired, kind: 'callback', config: {} }),
    ).toBeUndefined();
  });
});

const quiet = {
  all_human_waiting: false,
  has_human_wait: false,
  resume_work: false,
  lent_human_wait: false,
  has_running_or_timed_work: false,
  child_resume_work: false,
};

describe('human wait clock', () => {
  it('runs only for a live, uncancelled run within its deadline', () => {
    const run = {
      status: 'waiting',
      cancel_requested_at: null,
      deadline_expired: false,
    };
    expect(humanWaitClockRunning(run)).toBe(true);
    expect(humanWaitClockRunning({ ...run, status: 'running' })).toBe(true);
    expect(humanWaitClockRunning({ ...run, status: 'succeeded' })).toBe(false);
    expect(
      humanWaitClockRunning({ ...run, cancel_requested_at: new Date() }),
    ).toBe(false);
    expect(humanWaitClockRunning({ ...run, deadline_expired: true })).toBe(
      false,
    );
  });

  it('is quiescent when every step waits on a person and nothing can resume', () => {
    const waiting = { ...quiet, all_human_waiting: true, has_human_wait: true };
    expect(humanWaitQuiescent(waiting)).toBe(true);
    expect(humanWaitQuiescent({ ...waiting, resume_work: true })).toBe(false);
    expect(humanWaitQuiescent({ ...waiting, has_human_wait: false })).toBe(
      false,
    );
  });

  it('is quiescent while a lent slot waits on a person and no other work runs', () => {
    const lent = { ...quiet, lent_human_wait: true };
    expect(humanWaitQuiescent(lent)).toBe(true);
    expect(
      humanWaitQuiescent({ ...lent, has_running_or_timed_work: true }),
    ).toBe(false);
    expect(humanWaitQuiescent({ ...lent, child_resume_work: true })).toBe(
      false,
    );
  });
});
