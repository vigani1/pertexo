import type { PendingTaskListQuery } from '@pertexo/contracts';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { LabelledField } from '@/components/ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import type { TaskScope } from '../data/tasks.api';
import { TaskList } from '../components/task-list';
export function ApprovalsPage({
  scope,
  filters,
  onFilters,
}: Readonly<{
  scope: TaskScope;
  filters: Pick<PendingTaskListQuery, 'view' | 'status'>;
  onFilters: (filters: Pick<PendingTaskListQuery, 'view' | 'status'>) => void;
}>) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader>
        <PageHeaderTitle>Approvals</PageHeaderTitle>
      </PageHeader>
      <p className="max-w-2xl text-sm text-muted-foreground">
        One eligible person decides each request. The person who started a run
        cannot approve or reject it.
      </p>
      <div className="flex flex-wrap gap-4">
        <LabelledField id="approval-view" label="Audience">
          {(control) => (
            <Select
              value={filters.view}
              onValueChange={(value) => {
                onFilters({
                  ...filters,
                  view: value === 'all' ? 'all' : 'mine',
                });
              }}
            >
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mine">Mine</SelectItem>
                <SelectItem value="all">All in workspace</SelectItem>
              </SelectContent>
            </Select>
          )}
        </LabelledField>
        <LabelledField id="approval-status" label="Status">
          {(control) => (
            <Select
              value={filters.status}
              onValueChange={(value) => {
                onFilters({
                  ...filters,
                  status:
                    value === 'resolved'
                      ? 'resolved'
                      : value === 'all'
                        ? 'all'
                        : 'pending',
                });
              }}
            >
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Waiting</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          )}
        </LabelledField>
      </div>
      <TaskList scope={scope} filters={filters} />
    </div>
  );
}
