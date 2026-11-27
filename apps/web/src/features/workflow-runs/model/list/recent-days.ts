import type { RecentDay } from '@/components/patterns/dates/recent-days';
import { formatCalendarDay, formatWeekdayDate } from '@/lib/format/time';
import {
  customRangeInputs,
  customRangeSearch,
  localDateValue,
  withoutTimeRange,
  type RunSearch,
} from './run-search';

/** The Runs strip covers this many days, today last. */
export const RECENT_RUN_DAYS = 7;

/** The last seven local days, oldest first, for the Runs day strip. */
export function recentRunDays(nowMs: number): readonly RecentDay[] {
  return Array.from({ length: RECENT_RUN_DAYS }, (_, index) => {
    const date = new Date(nowMs);
    date.setDate(date.getDate() - (RECENT_RUN_DAYS - 1 - index));
    const today = index === RECENT_RUN_DAYS - 1;
    return {
      value: localDateValue(date.getTime()),
      label: today ? 'Today' : formatWeekdayDate(date),
      shortLabel: today ? 'Today' : String(date.getDate()),
      // Starts with the words on the button, so voice control finds it.
      name: `${today ? 'Today' : formatWeekdayDate(date)}, ${formatCalendarDay(date)}`,
    };
  });
}

/** The one day the search covers, when it is a single picked day. */
export function pickedDay(search: RunSearch): string | undefined {
  if (search.range !== 'custom') return undefined;
  const { from, to } = customRangeInputs(search);
  return from !== '' && from === to ? from : undefined;
}

/** Runs of one picked day, or no time limit once the day is let go. */
export function daySearch<Search extends RunSearch>(
  search: Search,
  day: string | undefined,
): Search {
  if (day === undefined) return withoutTimeRange(search) as Search;
  const next = customRangeSearch(search, day, day);
  // A day from the strip is always a valid local date.
  return next.ok ? next.search : search;
}
