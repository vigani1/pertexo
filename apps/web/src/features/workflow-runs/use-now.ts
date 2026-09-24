import { useEffect, useState } from 'react';

function readNow(): number {
  return Date.now();
}

/**
 * The current time, refreshed every `intervalMs` while `ticking` is true, so
 * elapsed times and countdowns move only while something is in flight.
 */
export function useNow(intervalMs: number, ticking: boolean): number {
  const [now, setNow] = useState(readNow);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs, ticking]);
  return now;
}
