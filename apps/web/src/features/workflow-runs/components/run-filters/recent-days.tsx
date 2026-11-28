import type { ReactNode } from 'react';
import { cn } from '@/lib/class-names';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import type { RecentDay } from '../../model/list/recent-days';

/**
 * The last few days as one strip: one click picks a day, a second click on
 * it lets go. Older days and ranges stay with the presets and the calendar.
 */
export function RecentDays({
  days,
  selected,
  onPick,
  label = 'Jump to a day',
  renderDetail,
}: Readonly<{
  days: readonly RecentDay[];
  selected: string | undefined;
  onPick: (value: string | undefined) => void;
  label?: string;
  renderDetail?: (day: RecentDay) => ReactNode;
}>) {
  return (
    <ToggleGroup
      aria-label={label}
      value={selected === undefined ? [] : [selected]}
      onValueChange={(values) => {
        const [next] = values;
        onPick(typeof next === 'string' ? next : undefined);
      }}
      className="grid w-full grid-cols-7 sm:w-fit"
    >
      {days.map((day) => (
        <ToggleGroupItem
          key={day.value}
          value={day.value}
          aria-label={day.name}
          className={cn(
            'min-w-0 justify-center px-1.5 sm:px-3',
            renderDetail !== undefined && 'flex-col gap-0 py-1',
          )}
        >
          <span className="max-sm:hidden">{day.label}</span>
          <span className="sm:hidden">{day.shortLabel}</span>
          {renderDetail?.(day)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
