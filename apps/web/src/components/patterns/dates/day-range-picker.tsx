import { useState } from 'react';
import { CalendarRangeIcon, ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LocalDate } from '@/components/ui/date-time-parts';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { DayRangeForm } from './day-range-form';

type Preset = Readonly<{
  label: string;
  selected?: boolean;
  apply: () => void;
}>;

export function DayRangePicker({
  title,
  label,
  presets,
  initial,
  markedDays,
  onApply,
  onClear,
  className,
}: Readonly<{
  title: string;
  label: string | undefined;
  presets: readonly Preset[];
  initial?: Readonly<{ from: LocalDate; to: LocalDate }> | undefined;
  markedDays?: ReadonlySet<LocalDate> | undefined;
  onApply: (from: LocalDate, to: LocalDate) => string | undefined;
  onClear: () => void;
  className?: string | undefined;
}>) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className={className}
            aria-label={`When: ${label ?? 'Any time'}`}
          />
        }
      >
        <CalendarRangeIcon aria-hidden="true" />
        <span className="max-w-48 truncate">{label ?? 'Any time'}</span>
        <ChevronDownIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-[min(28rem,calc(100vw-2rem))]">
        <PopoverTitle>{title}</PopoverTitle>
        <div className="mt-3 grid gap-3 min-[480px]:grid-cols-[auto_minmax(0,1fr)]">
          <div
            className="flex flex-wrap content-start gap-1 min-[480px]:flex-col"
            role="group"
            aria-label="Quick ranges"
          >
            {presets.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="sm"
                variant={preset.selected ? 'default' : 'ghost'}
                aria-pressed={preset.selected}
                onClick={() => {
                  preset.apply();
                  setOpen(false);
                }}
              >
                {preset.label}
              </Button>
            ))}
            {label === undefined ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
              >
                Any time
              </Button>
            )}
          </div>
          <DayRangeForm
            initial={initial}
            markedDays={markedDays}
            // Each tap applies at once; the calendar stays open so a second
            // tap can extend the day into a range.
            onApply={onApply}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
