import { CalendarRangeIcon, ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DayRangeForm } from '@/components/ui/day-range-form';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  presetRangeLabel,
  timeRangeLabel,
} from '../../model/list/run-filter-labels';
import {
  customRangeInputs,
  customRangeSearch,
  presetRangeSearch,
  runPresetRanges,
  withoutTimeRange,
  type RunSearch,
} from '../../model/list/run-search';

/**
 * When runs were created: rolling presets, or a custom range of calendar
 * days in the person's own time zone (shown, never silently UTC).
 */
export function TimeRangeFilter({
  search,
  onSearchChange,
}: Readonly<{
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
}>) {
  const [open, setOpen] = useState(false);
  const label = timeRangeLabel(search);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            // On a phone the range takes its own full row after the two
            // selects, so no filter sits alone at half width.
            className="order-last col-span-2 w-full justify-start font-normal text-foreground sm:order-none sm:col-span-1 sm:w-auto"
            aria-label={`When: ${label ?? 'Any time'}`}
          />
        }
      >
        <CalendarRangeIcon aria-hidden="true" />
        <span className="max-w-48 truncate">{label ?? 'Any time'}</span>
        <ChevronDownIcon aria-hidden="true" className="opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))]">
        <PopoverTitle>When runs started</PopoverTitle>
        <div
          className="mt-3 grid grid-cols-3 gap-1.5"
          role="group"
          aria-label="Quick ranges"
        >
          {runPresetRanges.map((range) => (
            <Button
              key={range}
              type="button"
              size="sm"
              variant={search.range === range ? 'default' : 'outline'}
              aria-pressed={search.range === range}
              onClick={() => {
                onSearchChange(presetRangeSearch(search, range, Date.now()));
                setOpen(false);
              }}
            >
              {presetRangeLabel(range)}
            </Button>
          ))}
        </div>
        <DayRangeForm
          {...(search.range === 'custom'
            ? { initial: customRangeInputs(search) }
            : {})}
          onApply={(from, to) => {
            const result = customRangeSearch(search, from, to);
            if (!result.ok) return result.message;
            onSearchChange(result.search);
            setOpen(false);
            return undefined;
          }}
        />
        {label === undefined ? null : (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-3"
            onClick={() => {
              onSearchChange(withoutTimeRange(search));
              setOpen(false);
            }}
          >
            Any time
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
