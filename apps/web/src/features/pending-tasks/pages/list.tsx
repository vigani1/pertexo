import type { ReactNode } from 'react';
import type { PendingTaskListQuery } from '@pertexo/contracts';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { TaskScope } from '../data/tasks.api';
import { TaskList } from '../components/task-list';

type TaskFilters = Pick<PendingTaskListQuery, 'view' | 'status' | 'kind'>;

const kinds = [
  { value: 'all', label: 'All requests' },
  { value: 'approval', label: 'Approvals' },
  { value: 'input_request', label: 'Input requests' },
];

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
            {views !== undefined
              ? 'Inbox'
              : filters.kind === 'approval'
                ? 'Approvals'
                : filters.kind === 'input_request'
                  ? 'Input requests'
                  : 'Requests'}
          </PageHeaderTitle>
          {views}
        </div>
        <PageHeaderActions>
          <Select
            items={kinds}
            value={filters.kind ?? 'all'}
            onValueChange={(value) => {
              onFilters({
                ...filters,
                kind:
                  value === 'approval' || value === 'input_request'
                    ? value
                    : 'all',
              });
            }}
          >
            <SelectTrigger aria-label="Show" className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kinds.map((kind) => (
                <SelectItem key={kind.value} value={kind.value}>
                  {kind.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        </PageHeaderActions>
      </PageHeader>
      <TaskList scope={scope} filters={filters} />
    </div>
  );
}
