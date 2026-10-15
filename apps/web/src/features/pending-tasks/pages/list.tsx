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
export function TasksPage({
  scope,
  filters,
  onFilters,
}: Readonly<{
  scope: TaskScope;
  filters: Pick<PendingTaskListQuery, 'view' | 'status' | 'kind'>;
  onFilters: (
    filters: Pick<PendingTaskListQuery, 'view' | 'status' | 'kind'>,
  ) => void;
}>) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader>
        <PageHeaderTitle>
          {filters.kind === 'approval'
            ? 'Approvals'
            : filters.kind === 'input_request'
              ? 'Input requests'
              : 'Requests'}
        </PageHeaderTitle>
      </PageHeader>
      <p className="max-w-2xl text-sm text-muted-foreground">
        One eligible member resolves each request. Run starters can supply
        input; approvals require another person.
      </p>
      <div className="flex flex-wrap gap-4">
        <LabelledField id="request-kind" label="Kind">
          {(control) => (
            <Select
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
              <SelectTrigger {...control} className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All requests</SelectItem>
                <SelectItem value="approval">Approvals</SelectItem>
                <SelectItem value="input_request">Input requests</SelectItem>
              </SelectContent>
            </Select>
          )}
        </LabelledField>
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
