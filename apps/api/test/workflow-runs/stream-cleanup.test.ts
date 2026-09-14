import { describe, expect, it, vi } from 'vitest';

import {
  NO_STREAM_FAILURE,
  preserveFailureDuringBoundedStreamCleanup,
  preserveFailureDuringStreamCleanup,
  StreamCleanupIncompleteError,
} from '../../src/workflow-runs/stream-cleanup.js';

describe('workflow event stream cleanup', () => {
  it('starts every cleanup before waiting for a noncooperative owner', async () => {
    vi.useFakeTimers();
    const held = Promise.withResolvers<undefined>();
    const primaryFailure = undefined;
    const siblingFailure = new Error('sibling cleanup failed');
    const first = vi.fn(() => held.promise);
    const second = vi.fn(() => Promise.reject(siblingFailure));
    try {
      const cleanup = preserveFailureDuringBoundedStreamCleanup(
        { error: primaryFailure, failed: true },
        [first, second],
        25,
      );
      const observed = cleanup.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25);
      const failure = await observed;

      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      expect(failure).toBeInstanceOf(StreamCleanupIncompleteError);
      expect((failure as StreamCleanupIncompleteError).errors).toEqual([
        undefined,
        siblingFailure,
        expect.objectContaining({
          message: 'Workflow event stream cleanup exceeded 25ms',
        }),
      ]);

      held.resolve(undefined);
      await (failure as StreamCleanupIncompleteError).completion;
      await expect(
        (failure as StreamCleanupIncompleteError).outcome,
      ).rejects.toSatisfy((lateFailure: unknown) => {
        expect(lateFailure).toBeInstanceOf(AggregateError);
        expect((lateFailure as AggregateError).errors).toEqual([
          undefined,
          siblingFailure,
        ]);
        return true;
      });
    } finally {
      held.resolve(undefined);
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('contains hostile single cleanup failures without inspecting their prototype', async () => {
    const hostile = new Proxy(Object.create(null) as object, {
      getPrototypeOf: () => {
        throw new Error('must not inspect cleanup failure');
      },
    });

    const failure = await preserveFailureDuringStreamCleanup(
      NO_STREAM_FAILURE,
      [
        () => {
          // Cleanup adapters may throw arbitrary values; containment is tested.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw hostile;
        },
      ],
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Workflow event stream cleanup failed',
    );
    expect((failure as Error).cause).toBe(hostile);
  });
});
