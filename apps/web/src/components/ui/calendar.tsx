import {
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
  type KeyboardEvent,
} from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import {
  formatCalendarDay,
  formatMonthName,
  formatMonthYear,
  weekdayNames,
} from '@/lib/format/time';
import { cn } from '@/lib/class-names';
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
  markedDays,
  onSelect,
}: Readonly<{
  value: LocalDate | undefined;
  min?: LocalDate;
  max?: LocalDate;
  range?: Readonly<{ from?: LocalDate; to?: LocalDate }>;
  markedDays?: ReadonlySet<LocalDate> | undefined;
  onSelect: (day: LocalDate) => void;
}>) {
  const headingId = useId();
  const today = localDateOf(new Date());
  const initialDay =
    value ??
    range?.from ??
    min ??
    (max !== undefined && max < today ? max : today);
  const [focused, setFocused] = useState<LocalDate>(initialDay);
  const moveFocus = useRef(false);
  const days = useRef(new Map<LocalDate, HTMLButtonElement>());
  const visible = dateOf(focused) ?? new Date();
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
          {sameMonth(focused, today) ||
          outsideBounds(today, { min, max }) ? null : (
            <Button
              type="button"
              variant="calendar-today"
              size="calendar-today"
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
            size="icon-round"
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
            size="icon-round"
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
      <CalendarGrid
        headingId={headingId}
        focused={focused}
        selection={{ value, min, max, range, today, markedDays }}
        days={days}
        onKeyDown={onKeyDown}
        onSelect={(day) => {
          setFocused(day);
          onSelect(day);
        }}
      />
    </div>
  );
}

type CalendarSelection = Readonly<{
  value: LocalDate | undefined;
  min: LocalDate | undefined;
  max: LocalDate | undefined;
  range: Readonly<{ from?: LocalDate; to?: LocalDate }> | undefined;
  today: LocalDate;
  markedDays: ReadonlySet<LocalDate> | undefined;
}>;

function outsideBounds(
  day: LocalDate,
  { min, max }: Pick<CalendarSelection, 'min' | 'max'>,
) {
  return (min !== undefined && day < min) || (max !== undefined && day > max);
}

function CalendarGrid({
  headingId,
  focused,
  selection,
  days,
  onKeyDown,
  onSelect,
}: Readonly<{
  headingId: string;
  focused: LocalDate;
  selection: CalendarSelection;
  days: RefObject<Map<LocalDate, HTMLButtonElement>>;
  onKeyDown: (event: KeyboardEvent<HTMLTableElement>) => void;
  onSelect: (day: LocalDate) => void;
}>) {
  const { value, range, today, markedDays } = selection;
  const chosen = (day: LocalDate) =>
    day === value || day === range?.from || day === range?.to;
  const between = (day: LocalDate) =>
    range?.from !== undefined &&
    range.to !== undefined &&
    day > range.from &&
    day < range.to;

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
    <table
      role="grid"
      aria-labelledby={headingId}
      className="w-full table-fixed border-separate border-spacing-y-1 pointer-coarse:min-w-70"
      onKeyDown={onKeyDown}
    >
      <thead>
        <tr>
          {weekdayNames().map((name) => (
            <th
              key={name}
              scope="col"
              className="pb-1 text-caption font-semibold tracking-wide text-subtle-foreground uppercase"
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
                  className={rangeCellClass(onBand, column, week.length)}
                >
                  <button
                    ref={(element) => {
                      if (element === null) days.current.delete(day);
                      else days.current.set(day, element);
                    }}
                    type="button"
                    tabIndex={day === focused ? 0 : -1}
                    disabled={outsideBounds(day, selection)}
                    aria-label={`${formatCalendarDay(date)}${markedDays?.has(day) ? ' (has runs)' : ''}`}
                    aria-pressed={chosen(day)}
                    aria-current={isToday ? 'date' : undefined}
                    className={cn(
                      'relative mx-auto grid h-8 w-full max-w-10 place-items-center rounded-sm border border-transparent font-mono text-caption tabular-nums text-muted-foreground outline-none transition-colors focus-ring disabled:pointer-events-none disabled:opacity-45 pointer-coarse:min-h-10 motion-reduce:transition-none',
                      outside && 'text-subtle-foreground opacity-50',
                      isToday &&
                        !chosen(day) &&
                        'border-border-strong font-semibold text-foreground',
                      onBand === 'middle' && 'text-foreground',
                      chosen(day)
                        ? 'bg-action font-semibold text-action-foreground'
                        : 'hover:bg-select-raised',
                    )}
                    onClick={() => {
                      onSelect(day);
                    }}
                  >
                    {date.getDate()}
                    {markedDays?.has(day) ? (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-1 left-1/2 size-0.75 -translate-x-1/2 rounded-full bg-current"
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
  );
}

function rangeCellClass(
  band: 'start' | 'middle' | 'end' | undefined,
  column: number,
  daysInWeek: number,
) {
  return cn(
    'relative p-0 text-center',
    band !== undefined &&
      "before:absolute before:inset-y-0.5 before:bg-action-soft before:content-['']",
    band === 'start' && 'before:right-0 before:left-1/2',
    band === 'end' && 'before:right-1/2 before:left-0',
    band === 'middle' && [
      'before:inset-x-0',
      column === 0 && 'before:left-1 before:rounded-l-full',
      column === daysInWeek - 1 && 'before:right-1 before:rounded-r-full',
    ],
  );
}
