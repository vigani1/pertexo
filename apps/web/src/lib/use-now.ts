import { useEffect, useState } from 'react';

/**
 * The wall-clock time, refreshed every `intervalMs` while `enabled` and until
 * `untilMs` has passed. The clock pauses while the tab is hidden and catches
 * up the moment it is shown again, so elapsed times and countdowns only move
 * while someone can see them, and nothing ticks when nothing needs it.
 */
export function useNow(
  intervalMs: number,
  enabled = true,
  untilMs = Number.POSITIVE_INFINITY,
): number {
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
