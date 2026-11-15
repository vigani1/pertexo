import { useEffect, useState } from 'react';

/** How often a clock on screen ticks, by what it shows. */
export const CLOCK_TICK = Object.freeze({
  /** A seconds countdown that must reach zero on time. */
  countdown: 250,
  /** Elapsed or remaining seconds. */
  seconds: 1_000,
  /** A chart whose "now" edge moves, such as the Loom. */
  chart: 15_000,
  /** Relative times in minutes: "2 min ago", "in 5 minutes". */
  relativeTime: 30_000,
});

/**
 * The wall-clock time, refreshed every `intervalMs` while `enabled` and until
 * `untilMs` has passed. The clock pauses while the tab is hidden and catches
 * up the moment it is shown again, so elapsed times and countdowns only move
 * while someone can see them, and nothing ticks when nothing needs it.
 */
export function useNow({
  intervalMs,
  enabled = true,
  untilMs = Number.POSITIVE_INFINITY,
}: Readonly<{
  intervalMs: number;
  enabled?: boolean | undefined;
  untilMs?: number | undefined;
}>): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= untilMs) stop();
    };
    const start = () => {
      if (timer === undefined && !document.hidden && Date.now() < untilMs)
        timer = window.setInterval(tick, intervalMs);
    };
    const followVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      tick();
      start();
    };
    start();
    document.addEventListener('visibilitychange', followVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', followVisibility);
    };
  }, [enabled, intervalMs, untilMs]);

  return now;
}
