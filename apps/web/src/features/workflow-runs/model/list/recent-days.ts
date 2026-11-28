import { formatCalendarDay, formatWeekdayDate } from '@/lib/format/time';
import {
  customRangeInputs,
  customRangeSearch,
  localDateValue,
  withoutTimeRange,
  type RunSearch,
} from './run-search';

export type RecentDay = Readonly<{
  /** The local day, `YYYY-MM-DD`. */
  value: string;
  /** "Today", or the short weekday and date: "Tue 24". */
  label: string;
  /** The date alone, where a phone has no room for the weekday. */
  shortLabel: string;
  /** The full date for assistive technology, after the button's own words: "Tue 24, Tuesday 24 November". */
  name: string;
}>;

/** The Runs strip covers this many days, today last. */
const RECENT_RUN_DAYS = 7;

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
