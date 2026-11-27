import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type RecentDay = Readonly<{
  /** The local day, `YYYY-MM-DD`. */
  value: string;
  /** "Today", or the short weekday and date: "Tue 24". */
  label: string;
  /** The date alone, where a phone has no room for the weekday. */
  shortLabel: string;
  /** The full date for assistive technology, after the button's own words: "Tue 24, Tuesday 24 November". */
  name: string;
}>;

/**
 * The last few days as one strip: one click picks a day, a second click on
 * it lets go. Older days and ranges stay with the presets and the calendar.
 */
export function RecentDays({
  days,
  selected,
  onPick,
  label = 'Jump to a day',
}: Readonly<{
  days: readonly RecentDay[];
  selected: string | undefined;
  onPick: (value: string | undefined) => void;
  label?: string;
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
          className="min-w-0 justify-center px-1.5 sm:px-3"
        >
          <span className="max-sm:hidden">{day.label}</span>
          <span className="sm:hidden">{day.shortLabel}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
