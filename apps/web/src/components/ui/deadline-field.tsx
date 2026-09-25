import { useId, useState, type RefCallback } from 'react';
import { CalendarIcon } from 'lucide-react';
import {
  formatDateTime,
  formatRelativeTime,
  localUtcOffset,
} from '@/lib/format-time';
import { useNow } from '@/lib/use-now';
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
import { Field, FieldControl, FieldDescription, FieldError } from './field';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

type Choice = 'none' | 'hour' | 'day' | 'custom';

const CHOICES: readonly Readonly<{ value: Choice; label: string }>[] = [
  { value: 'none', label: 'None' },
  { value: 'hour', label: 'In 1 hour' },
  { value: 'day', label: 'In 1 day' },
  { value: 'custom', label: 'Pick a time' },
];

const HOUR_MS = 3_600_000;
const FIVE_MINUTES_MS = 300_000;

/** "2026-09-25T14:35" on the local clock, rounded up to five minutes. */
function localDateTime(ms: number): string {
  const at = new Date(Math.ceil(ms / FIVE_MINUTES_MS) * FIVE_MINUTES_MS);
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return joinDateTime(localDateOf(at), clock);
}

/**
 * An optional deadline in Weft's own controls rather than the browser's
 * date-time picker, shared by the Run and Replay lenses: none, an hour or a
 * day from now, or a date and time on the person's own clock (their time
 * zone is named). The date can be typed or picked from a calendar; a typed
 * time like "930" tidies to 09:30 when left. The value is local
 * "YYYY-MM-DDTHH:MM" text, so the run input model validates it.
 */
export function DeadlineField({
  value,
  error,
  disabled,
  register,
  onChange,
}: Readonly<{
  value: string;
  error: string | undefined;
  disabled: boolean;
  /** Lets a failed submit focus the date when it's the first problem. */
  register: RefCallback<HTMLElement>;
  onChange: (text: string) => void;
}>) {
  const id = useId();
  const [choice, setChoice] = useState<Choice>(
    value === '' ? 'none' : 'custom',
  );
  const [calendarOpen, setCalendarOpen] = useState(false);
  const { date, time } = splitDateTime(value);
  const describedBy = [`${id}-hint`, error === undefined ? '' : `${id}-error`]
    .filter(Boolean)
    .join(' ');

  function choose(next: Choice) {
    setChoice(next);
    if (next === 'none') onChange('');
    else if (next !== 'custom')
      onChange(
        localDateTime(Date.now() + (next === 'hour' ? 1 : 24) * HOUR_MS),
      );
  }

  function changePart(nextDate: string, nextTime: string) {
    onChange(joinDateTime(nextDate.trim(), nextTime.trim()));
  }

  function leaveTime() {
    const clock = normalizeClock(time);
    const settled =
      clock === undefined || clock === time ? value : joinDateTime(date, clock);
    if (settled !== value) onChange(settled);
  }

  return (
    <Field
      role="group"
      aria-labelledby={`${id}-label`}
      data-invalid={error === undefined ? undefined : true}
    >
      <span id={`${id}-label`} className="text-sm font-medium">
        Deadline (optional)
      </span>
      <ToggleGroup
        aria-label="Deadline"
        value={[choice]}
        disabled={disabled}
        onValueChange={(next: string[]) => {
          const picked = CHOICES.find((item) => next.includes(item.value));
          if (picked !== undefined) choose(picked.value);
        }}
      >
        {CHOICES.map((item) => (
          <ToggleGroupItem key={item.value} value={item.value}>
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {choice === 'custom' ? (
        <FieldControl className="grid grid-cols-[minmax(0,1fr)_auto_6.5rem] gap-2">
          <Input
            ref={register}
            aria-label="Deadline date"
            aria-invalid={error !== undefined}
            aria-describedby={describedBy}
            name="deadline-date"
            autoComplete="off"
            inputMode="numeric"
            placeholder="YYYY-MM-DD"
            className="font-mono"
            disabled={disabled}
            value={date}
            onChange={(event) => {
              changePart(event.currentTarget.value, time);
            }}
          />
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Choose the date from a calendar"
                  disabled={disabled}
                />
              }
            >
              <CalendarIcon aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-3">
              <Calendar
                value={dateOf(date) === undefined ? undefined : date}
                min={localDateOf(new Date())}
                onSelect={(day) => {
                  changePart(day, time === '' ? defaultClock(day) : time);
                  setCalendarOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
          <Input
            aria-label="Deadline time"
            aria-invalid={error !== undefined}
            aria-describedby={describedBy}
            name="deadline-time"
            autoComplete="off"
            inputMode="numeric"
            placeholder="HH:MM"
            className="font-mono"
            disabled={disabled}
            value={time}
            onChange={(event) => {
              changePart(date, event.currentTarget.value);
            }}
            onBlur={leaveTime}
          />
        </FieldControl>
      ) : null}
      <FieldDescription id={`${id}-hint`}>
        <DeadlineHint value={value} />
      </FieldDescription>
      {error === undefined ? null : (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      )}
    </Field>
  );
}

/** When the run would stop, or that it runs until it finishes. */
function DeadlineHint({ value }: Readonly<{ value: string }>) {
  const parsed = value === '' ? undefined : new Date(value);
  const at =
    parsed === undefined || Number.isNaN(parsed.getTime()) ? undefined : parsed;
  const now = useNow(30_000, at !== undefined);
  const offset = `In your time zone (${localUtcOffset()}).`;
  if (at === undefined)
    return (
      <>
        {offset} {value === '' ? 'Without one, the run has no deadline.' : ''}
      </>
    );
  return (
    <span className={cn(at.getTime() <= now && 'text-warning')}>
      {offset} The run stops at{' '}
      <time dateTime={at.toISOString()} className="font-mono">
        {formatDateTime(at.toISOString())}
      </time>{' '}
      ({formatRelativeTime(at.toISOString(), now)}) if it isn’t finished.
    </span>
  );
}
