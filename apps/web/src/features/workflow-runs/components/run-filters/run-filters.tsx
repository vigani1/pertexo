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
import { StatusGlyph } from '@/components/ui/status';
import { runFilterChips } from '../../model/run-filter-labels';
import {
  clearedRunSearch,
  hasRunFilters,
  withoutRunFilter,
  withoutTimeRange,
  type RunSearch,
} from '../../model/run-search';
import {
  describeRunStatus,
  describeTrigger,
  runStatuses,
  runTriggerTypes,
  type RunStatus,
  type RunTriggerType,
} from '../../model/run-status';
import { TimeRangeFilter } from './time-range-filter';

const statusItems = [
  { value: null, label: 'Any status' },
  ...runStatuses.map((status) => ({
    value: status,
    label: describeRunStatus(status).label,
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
}: Readonly<{
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
  workflowFilter?: ReactNode;
  workflowName?: string;
}>) {
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
          <SelectTrigger aria-label="Status" className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusItems.map((item) => (
              <SelectItem key={item.value ?? 'any'} value={item.value}>
                {item.value === null ? null : (
                  <StatusGlyph tone={describeRunStatus(item.value).tone} />
                )}
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TimeRangeFilter search={search} onSearchChange={onSearchChange} />
        <Select
          items={triggerItems}
          value={search.trigger ?? null}
          onValueChange={(value: RunTriggerType | null) => {
            const rest = withoutRunFilter(search, 'trigger');
            onSearchChange(value === null ? rest : { ...rest, trigger: value });
          }}
        >
          <SelectTrigger aria-label="Trigger" className="w-full sm:w-40">
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
        {hasRunFilters(search) ? (
          <Button
            type="button"
            variant="ghost"
            className="col-span-2 sm:col-span-1"
            onClick={() => {
              onSearchChange(clearedRunSearch(search));
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      {chips.length === 0 ? null : (
        <div
          role="group"
          aria-label="Applied run filters"
          className="flex min-w-0 flex-wrap items-center gap-1.5"
        >
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              title={chip.label}
              aria-label={`Remove filter ${chip.label}`}
              className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-sm border border-primary/25 bg-primary/8 px-2 py-1 text-xs text-accent-foreground outline-none hover:border-primary/50 focus-ring"
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
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
