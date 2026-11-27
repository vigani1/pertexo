import { RecentDays } from '@/components/patterns/dates/recent-days';
import { CLOCK_TICK, useNow } from '@/lib/hooks/use-now';
import {
  daySearch,
  pickedDay,
  recentRunDays,
} from '../../model/list/recent-days';
import type { WorkflowRunReadSummary } from '@pertexo/contracts';
import { localDateValue } from '../../model/list/run-search';
import { BusinessValueFilter } from './business-value';
import { XIcon } from 'lucide-react';
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
import { runFilterChips } from '../../model/list/run-filter-labels';
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
}: Readonly<{
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
  workflowFilter?: ReactNode;
  workflowName?: string;
  runs: readonly WorkflowRunReadSummary[];
}>) {
  const now = useNow({ intervalMs: CLOCK_TICK.relativeTime });
  const markedDays = new Set(
    runs.map((run) => localDateValue(Date.parse(run.createdAt))),
  );
  const chips = runFilterChips(search, workflowName);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
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
        <TimeRangeFilter
          search={search}
          onSearchChange={onSearchChange}
          markedDays={markedDays}
        />
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
        <BusinessValueFilter search={search} onSearchChange={onSearchChange} />
      </div>
      <RecentDays
        days={recentRunDays(now)}
        selected={pickedDay(search)}
        onPick={(day) => {
          onSearchChange(daySearch(search, day));
        }}
      />
      {chips.length === 0 ? null : (
        <div
          role="group"
          aria-label="Applied run filters"
          className="flex min-w-0 flex-wrap items-center gap-1.5"
        >
          {chips.map((chip) => (
            <Button
              variant="chip"
              size="sm"
              key={chip.key}
              type="button"
              title={chip.label}
              aria-label={`Remove filter ${chip.label}`}
              className="min-w-0"
              onClick={() => {
                onSearchChange(
                  chip.key === 'time'
                    ? withoutTimeRange(search)
                    : withoutRunFilter(search, chip.key),
                );
              }}
            >
              <span className="min-w-0 truncate">{chip.label}</span>
              <XIcon aria-hidden="true" className="size-3 shrink-0" />
            </Button>
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
      )}
    </div>
  );
}
