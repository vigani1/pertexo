import type { CoreDateConfig } from './validation.js';
type Unit = Extract<CoreDateConfig, { operation: 'add_duration' }>['unit'];
const MILLIS = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};
export function addDuration(
  instant: number,
  amount: number,
  unit: Unit,
): number {
  if (unit !== 'months') return instant + amount * MILLIS[unit];
  const date = new Date(instant);
  const day = date.getUTCDate();
  // Set day one before changing month: Date otherwise rolls Jan 31 into March.
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + amount);
  const lastDay = new Date(date);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return date.getTime();
}
