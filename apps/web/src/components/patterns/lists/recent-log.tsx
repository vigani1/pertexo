import { useId, type ReactNode } from 'react';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { QueryView } from '@/components/patterns/states/query-view';
import { SkeletonRows } from '@/components/ui/skeleton';
import { StatusGlyph, type StatusTone } from '@/components/ui/status';
import { statusToneText } from '@/components/ui/status-tone';
import {
  formatDateTime,
  formatDayHeading,
  formatRelativeTime,
} from '@/lib/format/time';
import { cn } from '@/lib/utils';

/** The parts of a paged (infinite) query a recent-activity list reads. */
export type RecentLogQuery = Readonly<{
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  isRefetching: boolean;
  isFetchNextPageError: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  dataUpdatedAt: number;
  refetch: () => unknown;
  fetchNextPage: () => unknown;
}>;

/** Newest-first entries in runs of the same day: "Today", "Yesterday", "Oct 12". */
function byDay<Item>(
  items: readonly Item[],
  dayOf: (item: Item) => string,
): readonly { heading: string; items: Item[] }[] {
  const days: { heading: string; items: Item[] }[] = [];
  for (const item of items) {
    const heading = formatDayHeading(dayOf(item));
    const last = days.at(-1);
    if (last?.heading === heading) last.items.push(item);
    else days.push({ heading, items: [item] });
  }
  return days;
}

/**
 * A short, newest-first log of what happened, one page at a time: loading
 * rows, one failure owner with Retry, an "as of" line when a refresh fails,
 * an empty sentence that says what will appear, and "Load older".
 */
export function RecentLog<Item>({
  query,
  items,
  itemKey,
  renderItem,
  dayOf,
  headingLevel: Heading = 'h4',
  copy,
}: Readonly<{
  /** Where the log sits in the page outline; a page's main log is an h2. */
  headingLevel?: 'h2' | 'h3' | 'h4';
  /** When an entry happened; given, entries are grouped under their day. */
  dayOf?: (item: Item) => string;
  query: RecentLogQuery;
  items: readonly Item[] | undefined;
  itemKey: (item: Item) => string;
  renderItem: (item: Item) => ReactNode;
  copy: Readonly<{
    /** The list's heading, e.g. "Recent deliveries". */
    title: string;
    /** A short mono note beside the heading, e.g. how long entries are kept. */
    note?: string;
    /** What the list holds, in the plural: "deliveries". */
    subject: string;
    loadMoreLabel: string;
    /** Shown when the log is known to be empty. */
    empty: ReactNode;
  }>;
}>) {
  const { title, note, subject, loadMoreLabel, empty } = copy;

  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Heading id={headingId} className="text-sm font-semibold">
          {title}
        </Heading>
        {note === undefined ? null : (
          <span className="font-mono text-[0.72rem] text-subtle-foreground">
            {note}
          </span>
        )}
      </div>
      <QueryView
        query={{ ...query, data: items }}
        resource={title}
        loading={
          <SkeletonRows label={`Loading ${title.toLowerCase()}`} rows={2} />
        }
        isEmpty={(shown) => shown.length === 0}
        empty={<p className="text-sm text-muted-foreground">{empty}</p>}
      >
        {(shown) =>
          dayOf === undefined ? (
            <ul aria-labelledby={headingId} className="flex flex-col">
              {shown.map((item) => (
                <li
                  key={itemKey(item)}
                  className="border-t border-border py-2.5 first:border-t-0"
                >
                  {renderItem(item)}
                </li>
              ))}
            </ul>
          ) : (
            byDay(shown, dayOf).map((day) => (
              <div key={day.heading} className="flex flex-col">
                <p className="pt-3 pb-1 text-xs font-medium text-subtle-foreground">
                  {day.heading}
                </p>
                <ul aria-label={day.heading} className="flex flex-col">
                  {day.items.map((item) => (
                    <li
                      key={itemKey(item)}
                      className="border-t border-border py-2.5 first:border-t-0"
                    >
                      {renderItem(item)}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )
        }
      </QueryView>
      <LoadMore
        subject={subject}
        label={loadMoreLabel}
        hasNextPage={query.hasNextPage}
        loading={query.isFetchingNextPage}
        failed={query.isFetchNextPageError}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </section>
  );
}

/**
 * One log entry: an outcome glyph, what happened in words, an optional
 * action (such as opening the run it started), and when, with details.
 */
export function RecentLogEntry({
  tone,
  label,
  detail,
  action,
  at,
  meta,
}: Readonly<{
  tone: StatusTone;
  label: ReactNode;
  /** More about what happened, when there is more to say. */
  detail?: string | undefined;
  action?: ReactNode;
  /** When it happened, as an ISO instant. */
  at: string;
  /** One mono line under the time, e.g. "HTTP 202 · 321 B". */
  meta?: string;
}>) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
      <StatusGlyph tone={tone} className={cn('mt-0.5', statusToneText[tone])} />
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {detail === undefined ? null : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {detail}
          </p>
        )}
        {action}
      </div>
      <p className="flex flex-col items-end gap-0.5 text-right font-mono text-[0.72rem] text-subtle-foreground">
        <time dateTime={at} title={formatDateTime(at)}>
          {formatRelativeTime(at)}
        </time>
        {meta === undefined ? null : <span>{meta}</span>}
      </p>
    </div>
  );
}
