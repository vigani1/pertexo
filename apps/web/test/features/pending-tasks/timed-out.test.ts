// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  blockedSentence,
  taskOutcome,
  timedOutAfter,
} from '@/features/pending-tasks/model/presentation';

const window = {
  createdAt: '2026-10-20T09:00:00.000Z',
  expiresAt: '2026-10-27T09:00:00.000Z',
  completedByName: null,
} as const;

describe('a request nobody answered', () => {
  it('says how long it waited when its run continued on Timed out', () => {
    const task = {
      ...window,
      status: 'expired',
      onExpiry: 'continue',
    } as const;
    expect(timedOutAfter(task)).toBe('Timed out after 7 days');
    expect(taskOutcome(task)).toBe('Timed out after 7 days');
    expect(
      blockedSentence({ blockedReason: 'expired', onExpiry: 'continue' }),
    ).toBe(
      'Nobody responded in time, so the run continued on its Timed out path.',
    );
  });

  it('still reads as expired when its step failed', () => {
    const task = { ...window, status: 'expired', onExpiry: 'fail' } as const;
    expect(timedOutAfter(task)).toBeUndefined();
    expect(taskOutcome(task)).toBe('Expired');
    expect(
      blockedSentence({ blockedReason: 'expired', onExpiry: 'fail' }),
    ).toBe(
      'This request expired, so its step failed. A failure route takes over if the workflow has one.',
    );
  });

  it('is not timed out while it still waits', () => {
    expect(
      timedOutAfter({ ...window, status: 'pending', onExpiry: 'continue' }),
    ).toBeUndefined();
  });
});
