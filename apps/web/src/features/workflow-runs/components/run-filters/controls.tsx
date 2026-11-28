import { RecentDays } from './recent-days';
import { CLOCK_TICK, useNow } from '@/lib/hooks/use-now';
import type { WorkflowRunReadSummary } from '@pertexo/contracts';
import { localDateValue } from '../../model/list/run-search';
import { BusinessValueFilter } from './business-value';
import { DismissibleFilterChip } from '@/components/patterns/lists/filter-chip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  daySearch,
  pickedDay,
  recentRunDays,
} from '../../model/list/recent-days';
import { presetRangeSearch } from '../../model/list/run-search';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StatusMark } from '@/components/patterns/status/status-mark';
import {
  presetRangeLabel,
  runFilterChips,
} from '../../model/list/run-filter-labels';
import {
  clearedRunSearch,
  withoutRunFilter,
  withoutTimeRange,
  type RunSearch,
} from '../../model/list/run-search';
import {
  describeRunStatus,
  describeTrigger,
  runStatuses,
  runTriggerTypes,
  type RunStatus,
  type RunTriggerType,
} from '../../model/presentation/run-status';
import { TimeRangeFilter } from './time-range';

const statusItems = [
  { value: null, label: 'Any status' },
  ...runStatuses.map((status) => ({
    value: status,
    label: describeRunStatus({ status }).label,
  })),
];

const triggerItems = [
  { value: null, label: 'Any trigger' },
  ...runTriggerTypes.map((trigger) => ({
    value: trigger,
    label: describeTrigger(trigger),
  })),
];

/**
 * The filter bar. Every value lives in the URL: status and time are sent to
 * the API, the trigger narrows the loaded runs. The workflow control is a
 * slot because only the workspace-wide list has one.
 */
export function RunFilters({
  search,
  onSearchChange,
  workflowFilter,
  workflowName,
  runs,
  partial = true,
}: Readonly<{
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
  workflowFilter?: ReactNode;
  workflowName?: string;
  runs: readonly WorkflowRunReadSummary[];
  partial?: boolean;
}>) {
  const now = useNow({ intervalMs: CLOCK_TICK.relativeTime });
  const counts = new Map<string, number>();
  const markedDays = new Set<ReturnType<typeof localDateValue>>();
  for (const run of runs) {
    const day = localDateValue(Date.parse(run.createdAt));
    markedDays.add(day);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const oldest = runs.at(-1);
  const oldestDay =
    oldest === undefined
      ? undefined
      : localDateValue(Date.parse(oldest.createdAt));
  const triggerFiltered = search.trigger !== undefined;
  const chips = runFilterChips(search, workflowName);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <RunDatePresets
          search={search}
          now={now}
          onSearchChange={onSearchChange}
        />
        <TimeRangeFilter
          search={search}
          onSearchChange={onSearchChange}
          markedDays={markedDays}
        />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <BusinessValueFilter search={search} onSearchChange={onSearchChange} />
        {workflowFilter}
        <Select
          items={statusItems}
          value={search.status ?? null}
          onValueChange={(value: RunStatus | null) => {
            const rest = withoutRunFilter(search, 'status');
            onSearchChange(value === null ? rest : { ...rest, status: value });
          }}
        >
          <SelectTrigger aria-label="Status" className="w-full sm:w-36 lg:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusItems.map((item) => (
              <SelectItem key={item.value ?? 'any'} value={item.value}>
                {item.value === null ? null : (
                  <StatusMark
                    display="mark"
                    tone={describeRunStatus({ status: item.value }).tone}
                  />
                )}
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={triggerItems}
          value={search.trigger ?? null}
          onValueChange={(value: RunTriggerType | null) => {
            const rest = withoutRunFilter(search, 'trigger');
            onSearchChange(value === null ? rest : { ...rest, trigger: value });
          }}
        >
          <SelectTrigger
            aria-label="Trigger"
            className="w-full sm:w-32 lg:w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {triggerItems.map((item) => (
              <SelectItem key={item.value ?? 'any'} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <RecentDays
        days={recentRunDays(now)}
        selected={pickedDay(search)}
        renderDetail={(day) => {
          const count = counts.get(day.value);
          if (
            count === undefined ||
            triggerFiltered ||
            (partial && (oldestDay === undefined || day.value <= oldestDay))
          )
            return null;
          return (
            <span className="font-mono text-caption text-subtle-foreground">
              {count}
            </span>
          );
        }}
        onPick={(day) => {
          onSearchChange(daySearch(search, day));
        }}
      />
      <AppliedRunFilters
        chips={chips}
        search={search}
        onSearchChange={onSearchChange}
      />
    </div>
  );
}

function RunDatePresets({
  search,
  now,
  onSearchChange,
}: Readonly<{
  search: RunSearch;
  now: number;
  onSearchChange: (search: RunSearch) => void;
}>) {
  const today = localDateValue(now);
  const activePreset = pickedDay(search) === today ? 'today' : search.range;
  return (
    <ToggleGroup
      aria-label="Run date presets"
      value={activePreset === undefined ? [] : [activePreset]}
      onValueChange={([value]) => {
        if (value === 'today') onSearchChange(daySearch(search, today));
        else if (value === '7d' || value === '30d')
          onSearchChange(presetRangeSearch(search, value, now));
        else onSearchChange(withoutTimeRange(search));
      }}
    >
      <ToggleGroupItem value="today">Today</ToggleGroupItem>
      {(['7d', '30d'] as const).map((preset) => (
        <ToggleGroupItem key={preset} value={preset}>
          {presetRangeLabel(preset).replace(/^Last /u, '')}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function AppliedRunFilters({
  chips,
  search,
  onSearchChange,
}: Readonly<{
  chips: ReturnType<typeof runFilterChips>;
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
}>) {
  return chips.length === 0 ? null : (
    <div
      role="group"
      aria-label="Applied run filters"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {chips.map((chip) => (
        <DismissibleFilterChip
          key={chip.key}
          label={chip.label}
          removeLabel={`Remove filter ${chip.label}`}
          onRemove={() => {
            onSearchChange(
              chip.key === 'time'
                ? withoutTimeRange(search)
                : withoutRunFilter(search, chip.key),
            );
          }}
        />
      ))}
      {/* One chip clears with its ×; several also clear at once, here
              beside them rather than as another row in the toolbar. */}
      {chips.length > 1 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onSearchChange(clearedRunSearch(search));
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
