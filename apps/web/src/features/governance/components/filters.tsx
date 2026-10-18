import { useState } from 'react';
import {
  CalendarRangeIcon,
  ChevronDownIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import type { AuditFilter } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import {
  dateOf,
  localDateOf,
  shiftDays,
} from '@/components/ui/date-time-parts';
import { DayRangeForm } from '@/components/ui/day-range-form';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDate, formatDateTime } from '@/lib/format/time';
import { AUDIT_SUBJECTS } from '../model/ledger';

const SUBJECTS = [{ value: 'any', label: 'Anything' }, ...AUDIT_SUBJECTS];
const PRESETS = [
  { label: 'Last 24 hours', ms: 86_400_000 },
  { label: 'Last 7 days', ms: 7 * 86_400_000 },
  { label: 'Last 30 days', ms: 30 * 86_400_000 },
] as const;

/** Drops the given keys, so a cleared filter leaves the address too. */
function without(
  filters: AuditFilter,
  ...keys: readonly (keyof AuditFilter)[]
): AuditFilter {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([key]) => !keys.includes(key as keyof AuditFilter),
    ),
  );
}

function rangeLabel(filters: AuditFilter): string | undefined {
  const { from, until } = filters;
  if (from === undefined && until === undefined) return undefined;
  const lastDay =
    until === undefined
      ? undefined
      : new Date(Date.parse(until) - 1).toISOString();
  if (from !== undefined && lastDay !== undefined) {
    const start = formatDate(from);
    const end = formatDate(lastDay);
    return start === end ? start : `${start} – ${end}`;
  }
  if (from !== undefined) return `Since ${formatDateTime(from)}`;
  return `Until ${formatDate(lastDay)}`;
}

function TimeRange({
  filters,
  onApply,
}: Readonly<{
  filters: AuditFilter;
  onApply: (filters: AuditFilter) => void;
}>) {
  const [open, setOpen] = useState(false);
  const label = rangeLabel(filters);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="font-normal text-foreground"
            aria-label={`When: ${label ?? 'Any time'}`}
          />
        }
      >
        <CalendarRangeIcon aria-hidden="true" />
        <span className="max-w-48 truncate">{label ?? 'Any time'}</span>
        <ChevronDownIcon aria-hidden="true" className="opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))]">
        <PopoverTitle>When it happened</PopoverTitle>
        <div
          className="mt-3 grid grid-cols-3 gap-1.5"
          role="group"
          aria-label="Quick ranges"
        >
          {PRESETS.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                onApply({
                  ...without(filters, 'from', 'until'),
                  from: new Date(Date.now() - preset.ms).toISOString(),
                });
                setOpen(false);
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <DayRangeForm
          initial={{
            from:
              filters.from === undefined
                ? ''
                : localDateOf(new Date(filters.from)),
            to:
              filters.until === undefined
                ? ''
                : localDateOf(new Date(Date.parse(filters.until) - 1)),
          }}
          onApply={(first, last) => {
            const from = dateOf(first);
            const until = dateOf(shiftDays(last, 1));
            if (from === undefined || until === undefined)
              return 'Pick both days again.';
            onApply({
              ...filters,
              from: from.toISOString(),
              until: until.toISOString(),
            });
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
              onApply(without(filters, 'from', 'until'));
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

/**
 * One row: who, what kind of thing and when. Narrowing to one exact action
 * or one thing starts from an event, and shows here as a chip to remove.
 */
export function AuditFilters({
  filters,
  actionWords,
  onApply,
}: Readonly<{
  filters: AuditFilter;
  /** The chosen action as the ledger says it, for its chip. */
  actionWords?: string;
  onApply: (filters: AuditFilter) => void;
}>) {
  const [person, setPerson] = useState(filters.person ?? '');
  const subject =
    SUBJECTS.find((item) => item.value === filters.targetType)?.value ?? 'any';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <form
          role="search"
          aria-label="Find a person"
          className="relative"
          onSubmit={(event) => {
            event.preventDefault();
            const name = person.trim();
            onApply(
              name === ''
                ? without(filters, 'person')
                : { ...filters, person: name },
            );
          }}
        >
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground"
          />
          <Input
            type="search"
            aria-label="Person"
            placeholder="Who did it"
            maxLength={256}
            value={person}
            onChange={(event) => {
              setPerson(event.target.value);
              // Clearing the box shows everyone again at once.
              if (event.target.value === '' && filters.person !== undefined)
                onApply(without(filters, 'person'));
            }}
            className="h-8 w-52 pl-8"
          />
        </form>
        <Select
          items={SUBJECTS}
          value={subject}
          onValueChange={(value) => {
            onApply(
              value === 'any' || typeof value !== 'string'
                ? without(filters, 'targetType', 'targetId')
                : { ...without(filters, 'targetId'), targetType: value },
            );
          }}
        >
          <SelectTrigger aria-label="What changed" className="h-8 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUBJECTS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TimeRange filters={filters} onApply={onApply} />
      </div>
      {filters.action === undefined && filters.targetId === undefined ? null : (
        <ul aria-label="Narrowed to" className="flex flex-wrap gap-2">
          {filters.action === undefined ? null : (
            <li>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                aria-label={`Show every kind of event, not only “${actionWords ?? filters.action}”`}
                onClick={() => {
                  onApply(without(filters, 'action'));
                }}
              >
                Only “{actionWords ?? filters.action}”
                <XIcon aria-hidden="true" />
              </Button>
            </li>
          )}
          {filters.targetId === undefined ? null : (
            <li>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                aria-label="Show events for everything, not only one item"
                onClick={() => {
                  onApply(without(filters, 'targetId'));
                }}
              >
                Only one item
                <XIcon aria-hidden="true" />
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
