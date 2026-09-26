import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import {
  formatCalendarDay,
  formatMonthName,
  formatMonthYear,
  weekdayNames,
} from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { Button } from './button';
import {
  dateOf,
  localDateOf,
  monthWeeks,
  sameMonth,
  shiftDays,
  shiftMonths,
  type LocalDate,
} from './date-time-parts';

const KEY_STEPS: Readonly<Record<string, (day: LocalDate) => LocalDate>> = {
  ArrowLeft: (day) => shiftDays(day, -1),
  ArrowRight: (day) => shiftDays(day, 1),
  ArrowUp: (day) => shiftDays(day, -7),
  ArrowDown: (day) => shiftDays(day, 7),
  PageUp: (day) => shiftMonths(day, -1),
  PageDown: (day) => shiftMonths(day, 1),
  Home: (day) => shiftDays(day, -(((dateOf(day)?.getDay() ?? 1) + 6) % 7)),
  End: (day) => shiftDays(day, 6 - (((dateOf(day)?.getDay() ?? 1) + 6) % 7)),
};

/**
 * A month of days to pick one from. Arrow keys move a day or a week, Page
 * Up/Down a month, Home/End to the week's ends; days before `min` or after
 * `max` can't be chosen. With `range`, its first and last days are marked
 * like a chosen day and the days between them are shaded.
 */
export function Calendar({
  value,
  min,
  max,
  range,
  onSelect,
}: Readonly<{
  value: LocalDate | undefined;
  min?: LocalDate;
  max?: LocalDate;
  range?: Readonly<{ from?: LocalDate; to?: LocalDate }>;
  onSelect: (day: LocalDate) => void;
}>) {
  const headingId = useId();
  const today = localDateOf(new Date());
  const [focused, setFocused] = useState<LocalDate>(
    value ??
      range?.from ??
      min ??
      (max !== undefined && max < today ? max : today),
  );
  const moveFocus = useRef(false);
  const days = useRef(new Map<LocalDate, HTMLButtonElement>());
  const visible = dateOf(focused) ?? new Date();
  const outOfBounds = (day: LocalDate) =>
    (min !== undefined && day < min) || (max !== undefined && day > max);
  const chosen = (day: LocalDate) =>
    day === value || day === range?.from || day === range?.to;
  const between = (day: LocalDate) =>
    range?.from !== undefined &&
    range.to !== undefined &&
    day > range.from &&
    day < range.to;

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    days.current.get(focused)?.focus();
  }, [focused]);

  function go(day: LocalDate) {
    if (min !== undefined && day < min) setFocused(min);
    else if (max !== undefined && day > max) setFocused(max);
    else setFocused(day);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const step = KEY_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    moveFocus.current = true;
    go(step(focused));
  }

  /** Where a day sits on the range's band, if it's on it at all. */
  function band(day: LocalDate): 'start' | 'middle' | 'end' | undefined {
    const from = range?.from;
    const to = range?.to;
    if (from === undefined || to === undefined || from === to) return undefined;
    if (day === from) return 'start';
    if (day === to) return 'end';
    return between(day) ? 'middle' : undefined;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <p
          id={headingId}
          aria-live="polite"
          className="flex items-baseline gap-1.5"
        >
          <span
            aria-hidden="true"
            className="font-display text-lg leading-none [--display-optical-size:24] [--display-width:86%]"
          >
            {formatMonthName(visible)}
          </span>
          <span
            aria-hidden="true"
            className="font-mono text-xs text-subtle-foreground"
          >
            {visible.getFullYear()}
          </span>
          <span className="sr-only">{formatMonthYear(visible)}</span>
        </p>
        <div className="flex items-center gap-1">
          {sameMonth(focused, today) || outOfBounds(today) ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs text-accent-foreground"
              onClick={() => {
                go(today);
              }}
            >
              Today
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="rounded-full"
            aria-label="Previous month"
            disabled={min !== undefined && sameMonth(focused, min)}
            onClick={() => {
              go(shiftMonths(focused, -1));
            }}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="rounded-full"
            aria-label="Next month"
            disabled={max !== undefined && sameMonth(focused, max)}
            onClick={() => {
              go(shiftMonths(focused, 1));
            }}
          >
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
      <table
        role="grid"
        aria-labelledby={headingId}
        className="w-full border-separate border-spacing-y-1"
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {weekdayNames().map((name) => (
              <th
                key={name}
                scope="col"
                className="pb-1 text-[0.68rem] font-semibold tracking-wide text-subtle-foreground uppercase"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthWeeks(focused).map((week) => (
            <tr key={week[0]}>
              {week.map((day, column) => {
                const date = dateOf(day) ?? new Date();
                const outside = !sameMonth(day, focused);
                const onBand = band(day);
                const isToday = day === today;
                return (
                  <td
                    key={day}
                    className={cn(
                      'relative p-0 text-center',
                      // The range is one band across the week, rounded where
                      // it starts, ends or wraps to the next row.
                      onBand !== undefined &&
                        "before:absolute before:inset-y-0.5 before:bg-action/14 before:content-['']",
                      onBand === 'middle' && 'before:inset-x-0',
                      onBand === 'start' && 'before:right-0 before:left-1/2',
                      onBand === 'end' && 'before:right-1/2 before:left-0',
                      onBand === 'middle' &&
                        column === 0 &&
                        'before:left-1 before:rounded-l-full',
                      onBand === 'middle' &&
                        column === week.length - 1 &&
                        'before:right-1 before:rounded-r-full',
                    )}
                  >
                    <button
                      ref={(element) => {
                        if (element === null) days.current.delete(day);
                        else days.current.set(day, element);
                      }}
                      type="button"
                      tabIndex={day === focused ? 0 : -1}
                      disabled={outOfBounds(day)}
                      aria-label={formatCalendarDay(date)}
                      aria-pressed={chosen(day)}
                      aria-current={isToday ? 'date' : undefined}
                      className={cn(
                        'relative mx-auto grid size-9 place-items-center rounded-full border border-transparent font-mono text-[0.8rem] tabular-nums outline-none transition-[background-color,border-color,box-shadow,color] duration-150 focus-ring hover:border-white/12 hover:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-25 motion-reduce:transition-none',
                        outside && 'text-subtle-foreground/70',
                        isToday && !chosen(day) && 'text-accent-foreground',
                        onBand === 'middle' && 'text-foreground',
                        // A chosen day is solid inside its ring, so the band
                        // stops at its edge rather than showing through.
                        chosen(day) && 'neon-outline bg-popover font-semibold',
                      )}
                      onClick={() => {
                        setFocused(day);
                        onSelect(day);
                      }}
                    >
                      {date.getDate()}
                      {isToday ? (
                        // Today: a bead of light under the number.
                        <span
                          aria-hidden="true"
                          className="absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]"
                        />
                      ) : null}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
