import { useId, useState, type RefCallback } from 'react';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  type FieldThread,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  formatDateTime,
  formatRelativeTime,
  localUtcOffset,
} from '@/lib/format-time';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';

type Choice = 'none' | 'hour' | 'day' | 'custom';

const choices: readonly Readonly<{ value: Choice; label: string }>[] = [
  { value: 'none', label: 'None' },
  { value: 'hour', label: 'In 1 hour' },
  { value: 'day', label: 'In 1 day' },
  { value: 'custom', label: 'Pick a time' },
];

const HOUR_MS = 3_600_000;
const FIVE_MINUTES_MS = 300_000;

/**
 * An optional deadline in Weft's own controls rather than the browser's
 * date-time picker: none, an hour or a day from now, or a date and time
 * typed on the person's own clock (their time zone is named). The value is
 * local "YYYY-MM-DDTHH:MM" text; the run's input model validates it.
 */
export function DeadlineField({
  value,
  error,
  thread,
  disabled,
  register,
  onChange,
  onBlur,
}: Readonly<{
  value: string;
  error: string | undefined;
  thread: FieldThread;
  disabled: boolean;
  /** Lets a failed submit focus the date when it's the first problem. */
  register: RefCallback<HTMLElement>;
  onChange: (text: string) => void;
  onBlur: () => void;
}>) {
  const id = useId();
  const [choice, setChoice] = useState<Choice>(
    value === '' ? 'none' : 'custom',
  );
  const [date = '', time = ''] = value.split('T');
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
    const trimmedDate = nextDate.trim();
    const trimmedTime = nextTime.trim();
    onChange(
      trimmedDate === '' && trimmedTime === ''
        ? ''
        : `${trimmedDate}T${trimmedTime}`,
    );
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
          const picked = choices.find((item) => next.includes(item.value));
          if (picked !== undefined) choose(picked.value);
        }}
      >
        {choices.map((item) => (
          <ToggleGroupItem key={item.value} value={item.value}>
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {choice === 'custom' ? (
        <FieldControl
          state={thread}
          className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2"
        >
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
            onBlur={onBlur}
          />
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
            onBlur={onBlur}
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

/** "2026-09-25T14:35" on the local clock, rounded up to five minutes. */
function localDateTime(ms: number): string {
  const at = new Date(Math.ceil(ms / FIVE_MINUTES_MS) * FIVE_MINUTES_MS);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
