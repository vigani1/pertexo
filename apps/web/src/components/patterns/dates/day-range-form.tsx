import { useState, type SyntheticEvent } from 'react';
import { formatDate, localTimeZone } from '@/lib/format/time';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  dateOf,
  localDateOf,
  type LocalDate,
} from '@/components/ui/date-time-parts';
import { FieldError } from '@/components/ui/field';

/** A picked day in words, e.g. "Sep 14, 2026". */
function dayWords(day: LocalDate): string {
  const date = dateOf(day);
  return date === undefined ? day : formatDate(date.toISOString());
}

/**
 * Whole days in the person's own time zone, picked on one calendar: the
 * first tap picks one day and the next extends the range. `onApply` answers with a
 * message when the owner refuses the range.
 */
export function DayRangeForm({
  initial,
  markedDays,
  onApply,
}: Readonly<{
  /** Days already chosen; empty text where an end is still open. */
  initial?: Readonly<{ from: string; to: string }> | undefined;
  markedDays?: ReadonlySet<LocalDate> | undefined;
  onApply: (from: LocalDate, to: LocalDate) => string | undefined;
}>) {
  const [from, setFrom] = useState(initial?.from ?? '');
  const [to, setTo] = useState(initial?.to ?? '');
  const [extending, setExtending] = useState(false);
  const [error, setError] = useState<string>();
  const today = localDateOf(new Date());

  function pick(day: LocalDate) {
    setError(undefined);
    if (extending && from !== '') {
      setFrom(day < from ? day : from);
      setTo(day < from ? from : day);
    } else {
      setFrom(day);
      setTo(day);
    }
    setExtending(!extending);
  }

  function apply(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (from === '' || to === '') return;
    setError(onApply(from, to));
  }

  return (
    <form className="min-w-0" onSubmit={apply}>
      <p className="text-xs font-medium text-muted-foreground">Custom days</p>
      <p aria-live="polite" className="mt-1 text-sm">
        {rangeCaption(from, to)}
      </p>
      <div className="mt-2">
        <Calendar
          value={undefined}
          max={today}
          markedDays={markedDays}
          range={{
            ...(from === '' ? {} : { from }),
            ...(to === '' ? {} : { to }),
          }}
          onSelect={pick}
        />
      </div>
      <p className="mt-2 text-xs text-subtle-foreground">
        Your time zone is {localTimeZone()}. Pick another day to extend the
        range.
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
