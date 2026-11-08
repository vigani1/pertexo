import { useState, type ReactNode } from 'react';
import { SlidersHorizontalIcon } from 'lucide-react';
import type { PendingTaskListQuery } from '@pertexo/contracts';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { TaskScope } from '../data/tasks.api';
import { TaskList } from '../components/task-list';

type TaskFilters = Pick<PendingTaskListQuery, 'view' | 'status' | 'kind'>;

export function TasksPage({
  scope,
  filters,
  views,
  onFilters,
}: Readonly<{
  scope: TaskScope;
  filters: TaskFilters;
  /** Shown under the Inbox title when requests are one of its views. */
  views?: ReactNode;
  onFilters: (filters: TaskFilters) => void;
}>) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader>
        <div className="flex flex-col gap-4">
          <PageHeaderTitle>
            {views !== undefined ? 'Inbox' : requestTitle(filters.kind)}
          </PageHeaderTitle>
          {views}
        </div>
        <PageHeaderActions>
          <ToggleGroup
            aria-label="Status"
            value={[filters.status]}
            onValueChange={(values) => {
              const next: unknown = values[0];
              if (next === 'pending' || next === 'resolved' || next === 'all')
                onFilters({ ...filters, status: next });
            }}
          >
            <ToggleGroupItem value="pending">Waiting</ToggleGroupItem>
            <ToggleGroupItem value="resolved">Resolved</ToggleGroupItem>
            <ToggleGroupItem value="all">All</ToggleGroupItem>
          </ToggleGroup>
          <RequestFilters filters={filters} onFilters={onFilters} />
        </PageHeaderActions>
      </PageHeader>
      <TaskList scope={scope} filters={filters} />
    </div>
  );
}

/**
 * What kind of request and whose: the status stays one click away, these
 * fold into Filters like the workflow list, with a count when either moved.
 */
function RequestFilters({
  filters,
  onFilters,
}: Readonly<{
  filters: TaskFilters;
  onFilters: (filters: TaskFilters) => void;
}>) {
  const [open, setOpen] = useState(false);
  const kind = filters.kind ?? 'all';
  const count = (kind === 'all' ? 0 : 1) + (filters.view === 'mine' ? 0 : 1);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <SlidersHorizontalIcon aria-hidden="true" data-icon="inline-start" />
        Filters{count === 0 ? '' : ` (${String(count)})`}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-4"
      >
        <PopoverTitle>Filter requests</PopoverTitle>
        <FilterChoice label="Kind">
          <ToggleGroup
            aria-label="Kind"
            value={[kind]}
            onValueChange={(values) => {
              const next: unknown = values[0];
              if (
                next === 'all' ||
                next === 'approval' ||
                next === 'input_request'
              )
                onFilters({ ...filters, kind: next });
            }}
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            <ToggleGroupItem value="approval">Approvals</ToggleGroupItem>
            <ToggleGroupItem value="input_request">Input</ToggleGroupItem>
          </ToggleGroup>
        </FilterChoice>
        <FilterChoice label="Whose">
          <ToggleGroup
            aria-label="Whose requests"
            value={[filters.view]}
            onValueChange={(values) => {
              const next: unknown = values[0];
              if (next === 'mine' || next === 'all')
                onFilters({ ...filters, view: next });
            }}
          >
            <ToggleGroupItem value="mine">For me</ToggleGroupItem>
            <ToggleGroupItem value="all">Everyone</ToggleGroupItem>
          </ToggleGroup>
        </FilterChoice>
      </PopoverContent>
    </Popover>
  );
}

function FilterChoice({
  label,
  children,
}: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <p aria-hidden="true" className="text-xs text-subtle-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function requestTitle(kind: TaskFilters['kind']): string {
  if (kind === 'approval') return 'Approvals';
  if (kind === 'input_request') return 'Input requests';
  return 'Requests';
}
