import { DayRangePicker } from '@/components/patterns/dates/day-range-picker';
import type { LocalDate } from '@/components/ui/date-time-parts';
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
  markedDays,
}: Readonly<{
  search: RunSearch;
  markedDays?: ReadonlySet<LocalDate> | undefined;
  onSearchChange: (search: RunSearch) => void;
}>) {
  return (
    <DayRangePicker
      title="When runs started"
      label={timeRangeLabel(search)}
      className="order-last col-span-2 w-full justify-start sm:order-none sm:col-span-1 sm:w-auto"
      presets={runPresetRanges.map((range) => ({
        label: presetRangeLabel(range),
        selected: search.range === range,
        apply: () => {
          onSearchChange(presetRangeSearch(search, range, Date.now()));
        },
      }))}
      initial={
        search.range === 'custom' ? customRangeInputs(search) : undefined
      }
      markedDays={markedDays}
      onApply={(from, to) => {
        const result = customRangeSearch(search, from, to);
        if (!result.ok) return result.message;
        onSearchChange(result.search);
        return undefined;
      }}
      onClear={() => {
        onSearchChange(withoutTimeRange(search));
      }}
    />
  );
}
