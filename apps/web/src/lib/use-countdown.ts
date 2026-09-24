import { useMemo, useState } from 'react';
import { useNow } from './use-now';

const TICK_MS = 250;

type Span = Readonly<{ startedAt: number; deadline: number }>;

export type Countdown = Readonly<{
  /** Whole seconds left; 0 once the deadline has passed or none is set. */
  remainingSeconds: number;
  startSeconds(seconds: number): void;
  startUntil(deadlineMs: number): void;
  clear(): void;
}>;

/**
 * A wall-clock countdown for cooldowns, `Retry-After` waits and time windows,
 * built on `useNow`. It counts toward a deadline instead of decrementing, so
 * a throttled or backgrounded tab shows the right number as soon as it wakes
 * up, and the clock stops once the deadline has passed.
 */
export function useCountdown(): Countdown {
  const [span, setSpan] = useState<Span>();
  const now = useNow(TICK_MS, span !== undefined, span?.deadline);
  // A countdown started after the clock last ticked counts from its own start.
  const remainingSeconds =
    span === undefined
      ? 0
      : Math.max(
          0,
          Math.ceil((span.deadline - Math.max(now, span.startedAt)) / 1_000),
        );

  const actions = useMemo(
    () => ({
      startSeconds(seconds: number) {
        const startedAt = Date.now();
        setSpan({ startedAt, deadline: startedAt + seconds * 1_000 });
      },
      startUntil(deadlineMs: number) {
        setSpan({ startedAt: Date.now(), deadline: deadlineMs });
      },
      clear() {
        setSpan(undefined);
      },
    }),
    [],
  );

  return { remainingSeconds, ...actions };
}
