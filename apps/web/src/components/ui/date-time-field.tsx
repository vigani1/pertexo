import { useId, useState, type Ref } from 'react';
import { CalendarIcon, XIcon } from 'lucide-react';
import { formatCalendarDay } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Calendar } from './calendar';
import {
  dateOf,
  defaultClock,
  joinDateTime,
  localDateOf,
  normalizeClock,
  splitDateTime,
} from './date-time-parts';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

type Preset = Readonly<{ label: string; at: (now: Date) => Date }>;

const PRESETS: readonly Preset[] = [
  {
    label: 'In 1 hour',
    at: (now) => new Date(now.getTime() + 3_600_000),
  },
  {
    label: 'Tomorrow 09:00',
    at: (now) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9),
  },
  {
    label: 'In 1 week',
    at: (now) =>
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 7,
        now.getHours(),
        now.getMinutes(),
      ),
  },
];

function localDateTimeOf(date: Date): string {
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return joinDateTime(localDateOf(date), time);
}

/**
 * Weft's date and time control, in place of the browser's native picker: a
 * day from a calendar lens (with a few quick picks), a typed 24-hour time,
 * and a clear button. The value is local wall-clock text shaped like a
 * `datetime-local` input's, e.g. "2026-09-25T14:30"; an unfinished time
 * stays in the value as typed so the form's validation can explain it.
 * `id` and the ARIA props go to the day button, which the field's label
 * names; the chosen day is read as its description.
 */
export function DateTimeField({
  id,
  value,
  onValueChange,
  onBlur,
  disabled = false,
  ref,
  timeLabel = 'Time',
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
}: Readonly<{
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Leaving a part of the field, with the value as it now stands. */
  onBlur?: (value: string) => void;
  disabled?: boolean;
  ref?: Ref<HTMLButtonElement>;
  timeLabel?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string | undefined;
}>) {
  const [open, setOpen] = useState(false);
  const dayTextId = useId();
  const { date, time } = splitDateTime(value);
  const day = dateOf(date);
  const today = localDateOf(new Date());
  const describedByDay = [dayTextId, describedBy].filter(Boolean).join(' ');

  function pickDay(next: string) {
    onValueChange(joinDateTime(next, time === '' ? defaultClock(next) : time));
    setOpen(false);
  }

  return (
    <div
      className={cn(
        'recessed-control flex h-9 w-full min-w-0 items-center gap-1 rounded-md border pr-1 focus-within:border-primary',
        invalid === true &&
          'border-[color-mix(in_srgb,var(--destructive)_60%,transparent)]',
        disabled && 'opacity-50',
      )}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          ref={ref}
          id={id}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedByDay}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-md px-3 text-left text-sm outline-none focus-visible:bg-white/[0.04]"
          onBlur={() => {
            onBlur?.(value);
          }}
        >
          <CalendarIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-subtle-foreground"
          />
          <span
            id={dayTextId}
            className={cn(
              'truncate',
              day === undefined && 'text-subtle-foreground',
            )}
          >
            {day === undefined ? 'No date' : formatCalendarDay(day)}
          </span>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3">
          <Calendar
            value={day === undefined ? undefined : date}
            min={today}
            onSelect={pickDay}
          />
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-white/6 pt-3">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  onValueChange(localDateTimeOf(preset.at(new Date())));
                  setOpen(false);
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <span aria-hidden="true" className="h-5 w-px bg-white/10" />
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        maxLength={5}
        placeholder="HH:MM"
        aria-label={timeLabel}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        disabled={disabled}
        value={time}
        className="h-full w-16 min-w-0 bg-transparent px-2 text-center font-mono text-sm outline-none placeholder:text-subtle-foreground"
        onChange={(event) => {
          const typed = event.currentTarget.value;
          // A time needs a day: typing one first assumes today.
          onValueChange(
            joinDateTime(typed === '' || date !== '' ? date : today, typed),
          );
        }}
        onBlur={() => {
          const clock = normalizeClock(time);
          const settled =
            clock === undefined || clock === time
              ? value
              : joinDateTime(date, clock);
          if (settled !== value) onValueChange(settled);
          onBlur?.(settled);
        }}
      />
      {value === '' ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Clear the date and time"
          disabled={disabled}
          onClick={() => {
            onValueChange('');
          }}
        >
          <XIcon aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
