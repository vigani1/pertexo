import { useState, type Ref } from 'react';
import { CalendarIcon } from 'lucide-react';
import { Button } from './button';
import { Calendar } from './calendar';
import { dateOf } from './date-time-parts';
import type { LabelledControlProps } from './field';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/**
 * A calendar day in Weft's own controls rather than the browser's date
 * picker, for a `LabelledField`: typed as `YYYY-MM-DD`, or picked from a
 * `Calendar`. The value is that text, so callers validate what was typed.
 */
export function DateInput({
  control,
  value,
  disabled,
  required,
  inputRef,
  onChange,
}: Readonly<{
  control: LabelledControlProps;
  value: string;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  inputRef?: Ref<HTMLInputElement> | undefined;
  onChange: (value: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
      <Input
        {...control}
        ref={inputRef}
        autoComplete="off"
        inputMode="numeric"
        placeholder="YYYY-MM-DD"
        className="font-mono"
        disabled={disabled}
        required={required}
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
      <Popover open={open} onOpenChange={setOpen}>
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
            value={dateOf(value.trim()) === undefined ? undefined : value.trim()}
            onSelect={(day) => {
              onChange(day);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
