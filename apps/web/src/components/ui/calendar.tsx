import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import {
  formatCalendarDay,
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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Previous month"
          disabled={min !== undefined && sameMonth(focused, min)}
          onClick={() => {
            go(shiftMonths(focused, -1));
          }}
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <p
          id={headingId}
          aria-live="polite"
          className="font-heading text-sm font-semibold"
        >
          {formatMonthYear(visible)}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Next month"
          disabled={max !== undefined && sameMonth(focused, max)}
          onClick={() => {
            go(shiftMonths(focused, 1));
          }}
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </div>
      <table
        role="grid"
        aria-labelledby={headingId}
        className="w-full border-collapse"
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {weekdayNames().map((name) => (
              <th
                key={name}
                scope="col"
                className="pb-1 font-mono text-[0.66rem] font-normal text-subtle-foreground"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthWeeks(focused).map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const date = dateOf(day) ?? new Date();
                const outside = !sameMonth(day, focused);
                return (
                  <td key={day} className="p-0.5 text-center">
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
                      aria-current={day === today ? 'date' : undefined}
                      className={cn(
                        'grid size-8 place-items-center rounded-md font-mono text-[0.78rem] outline-none transition-colors hover:bg-white/8 focus-ring disabled:pointer-events-none disabled:opacity-30',
                        outside && 'text-subtle-foreground',
                        day === today &&
                          'text-accent-foreground underline decoration-primary/60 underline-offset-4',
                        between(day) && 'bg-action/15 text-foreground',
                        chosen(day) &&
                          'bg-action text-action-foreground no-underline hover:bg-action-hover',
                      )}
                      onClick={() => {
                        setFocused(day);
                        onSelect(day);
                      }}
                    >
                      {date.getDate()}
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
