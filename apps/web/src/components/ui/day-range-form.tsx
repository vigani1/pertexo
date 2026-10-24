import { useState, type SyntheticEvent } from 'react';
import { formatDate, localTimeZone } from '@/lib/format/time';
import { Button } from './button';
import { Calendar } from './calendar';
import { dateOf, localDateOf, type LocalDate } from './date-time-parts';
import { FieldError } from './field';

/** A picked day in words, e.g. "Sep 14, 2026". */
function dayWords(day: LocalDate): string {
  const date = dateOf(day);
  return date === undefined ? day : formatDate(date.toISOString());
}

/**
 * Whole days in the person's own time zone, picked on one calendar: the
 * first tap starts the range and the next ends it. `onApply` answers with a
 * message when the owner refuses the range.
 */
export function DayRangeForm({
  initial,
  onApply,
}: Readonly<{
  /** Days already chosen; empty text where an end is still open. */
  initial?: Readonly<{ from: string; to: string }>;
  onApply: (from: LocalDate, to: LocalDate) => string | undefined;
}>) {
  const [from, setFrom] = useState(initial?.from ?? '');
  const [to, setTo] = useState(initial?.to ?? '');
  const [error, setError] = useState<string>();
  const today = localDateOf(new Date());

  // The first tap starts a range and the next ends it; a tap before the
  // start moves the start, and a tap once both are set starts over.
  function pick(day: LocalDate) {
    setError(undefined);
    if (from === '' || to !== '') {
      setFrom(day);
      setTo('');
    } else if (day < from) setFrom(day);
    else setTo(day);
  }

  function apply(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (from === '' || to === '') return;
    setError(onApply(from, to));
  }

  return (
    <form className="mt-4 border-t border-border pt-4" onSubmit={apply}>
      <p className="text-xs font-medium text-muted-foreground">Custom days</p>
      <p aria-live="polite" className="mt-1 text-sm">
        {rangeCaption(from, to)}
      </p>
      <div className="mt-2">
        <Calendar
          value={undefined}
          max={today}
          range={{
            ...(from === '' ? {} : { from }),
            ...(to === '' ? {} : { to }),
          }}
          onSelect={pick}
        />
      </div>
      <p className="mt-2 text-xs text-subtle-foreground">
        Whole days in your time zone, {localTimeZone()}. Pick a day twice for
        just that day.
      </p>
      {error === undefined ? null : (
        <FieldError className="mt-2">{error}</FieldError>
      )}
      {/* Nothing to apply until the range has both ends. */}
      <Button
        type="submit"
        variant="primary"
        size="sm"
        className="mt-3 w-full"
        disabled={from === '' || to === ''}
      >
        Apply range
      </Button>
    </form>
  );
}

function rangeCaption(from: LocalDate, to: LocalDate): string {
  if (from === '') {
    return 'Pick the first day.';
  }
  if (to === '') {
    return `From ${dayWords(from)}. Now pick the last day.`;
  }
  if (from === to) {
    return dayWords(from);
  }
  return `${dayWords(from)} to ${dayWords(to)}`;
}
