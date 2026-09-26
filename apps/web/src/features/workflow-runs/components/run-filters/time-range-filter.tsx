import { CalendarRangeIcon, ChevronDownIcon } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { localTimeZone } from '@/lib/format-time';
import {
  presetRangeLabel,
  timeRangeLabel,
} from '../../model/run-filter-labels';
import {
  customRangeInputs,
  customRangeSearch,
  presetRangeSearch,
  runPresetRanges,
  withoutTimeRange,
  type RunSearch,
} from '../../model/run-search';

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
      <PopoverContent className="w-80 sm:w-96">
        <PopoverTitle>When runs started</PopoverTitle>
        <div
          className="mt-3 grid grid-cols-2 gap-1.5"
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
        <CustomRangeForm
          search={search}
          onApply={(next) => {
            onSearchChange(next);
            setOpen(false);
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

function CustomRangeForm({
  search,
  onApply,
}: Readonly<{ search: RunSearch; onApply: (search: RunSearch) => void }>) {
  const initial =
    search.range === 'custom' ? customRangeInputs(search) : undefined;
  const [from, setFrom] = useState(initial?.from ?? '');
  const [to, setTo] = useState(initial?.to ?? '');
  const [error, setError] = useState<string>();

  function apply(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = customRangeSearch(search, from, to);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(undefined);
    onApply(result.search);
  }

  return (
    <form className="mt-4 border-t border-border pt-4" onSubmit={apply}>
      <p className="text-xs font-medium text-muted-foreground">Custom days</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="run-range-from" className="text-xs">
            From
          </FieldLabel>
          <Input
            id="run-range-from"
            type="date"
            value={from}
            aria-invalid={error !== undefined}
            onChange={(event) => {
              setFrom(event.currentTarget.value);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="run-range-to" className="text-xs">
            To
          </FieldLabel>
          <Input
            id="run-range-to"
            type="date"
            value={to}
            aria-invalid={error !== undefined}
            onChange={(event) => {
              setTo(event.currentTarget.value);
            }}
          />
        </Field>
      </div>
      <p className="mt-2 text-xs text-subtle-foreground">
        Whole days in your time zone, {localTimeZone()}.
      </p>
      {error === undefined ? null : (
        <FieldError className="mt-2">{error}</FieldError>
      )}
      <Button type="submit" size="sm" className="mt-3 w-full">
        Apply range
      </Button>
    </form>
  );
}
