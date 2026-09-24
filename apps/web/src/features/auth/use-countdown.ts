import { useEffect, useMemo, useState } from 'react';

const TICK_MS = 250;

export type Countdown = Readonly<{
  /** Whole seconds left; 0 once the deadline has passed or none is set. */
  remainingSeconds: number;
  startSeconds(seconds: number): void;
  startUntil(deadlineMs: number): void;
  clear(): void;
}>;

/**
 * A wall-clock countdown for resend cooldowns, rate limits and time windows.
 * It counts toward a deadline instead of decrementing, so a throttled or
 * backgrounded tab shows the right number as soon as it wakes up.
 */
export function useCountdown(): Countdown {
  const [deadline, setDeadline] = useState<number>();
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (deadline === undefined) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline) setDeadline(undefined);
    }, TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [deadline]);

  const actions = useMemo(
    () => ({
      startSeconds(seconds: number) {
        const current = Date.now();
        setNow(current);
        setDeadline(current + seconds * 1_000);
      },
      startUntil(deadlineMs: number) {
        setNow(Date.now());
        setDeadline(deadlineMs);
      },
      clear() {
        setDeadline(undefined);
      },
    }),
    [],
  );

  const remainingSeconds =
    deadline === undefined
      ? 0
      : Math.max(0, Math.ceil((deadline - now) / 1_000));
  return { remainingSeconds, ...actions };
}

/** "0:24", "4:59" — the instrument voice for a countdown. */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}
