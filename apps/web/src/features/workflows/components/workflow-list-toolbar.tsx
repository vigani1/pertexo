import type { Ref } from 'react';
import { SearchIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { WorkflowSort, WorkflowView } from '../model/workflow-list-view';

const VIEWS: readonly Readonly<{ value: WorkflowView; label: string }>[] = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
];

const SORTS: readonly Readonly<{ value: WorkflowSort; label: string }>[] = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Oldest first' },
];

function isView(value: string | undefined): value is WorkflowView {
  return VIEWS.some((view) => view.value === value);
}

function isSort(value: unknown): value is WorkflowSort {
  return SORTS.some((sort) => sort.value === value);
}

export function WorkflowListToolbar({
  filterRef,
  query,
  view,
  sort,
  counts,
  hasMore,
  onQueryChange,
  onViewChange,
  onSortChange,
}: Readonly<{
  filterRef: Ref<HTMLInputElement>;
  query: string;
  view: WorkflowView;
  sort: WorkflowSort;
  counts: Readonly<Record<WorkflowView, number>>;
  hasMore: boolean;
  onQueryChange: (query: string) => void;
  onViewChange: (view: WorkflowView) => void;
  onSortChange: (sort: WorkflowSort) => void;
}>) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="relative w-full sm:w-72">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle-foreground"
        />
        <Input
          ref={filterRef}
          type="search"
          aria-label="Filter workflows by name"
          placeholder="Filter by name"
          autoComplete="off"
          value={query}
          className="pr-9 pl-9"
          onChange={(event) => {
            onQueryChange(event.target.value);
          }}
        />
        <Kbd
          aria-hidden="true"
          className="absolute top-1/2 right-2.5 -translate-y-1/2"
        >
          /
        </Kbd>
      </div>
      <ToggleGroup
        aria-label="Which workflows to show"
        value={[view]}
        onValueChange={(next) => {
          const [selected] = next;
          if (isView(selected)) onViewChange(selected);
        }}
      >
        {VIEWS.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
            {option.value === 'all' ? null : (
              <span className="font-mono text-[0.68rem] text-subtle-foreground">
                {String(counts[option.value])}
                {hasMore ? '+' : ''}
              </span>
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Select
        items={SORTS}
        value={sort}
        onValueChange={(next) => {
          if (isSort(next)) onSortChange(next);
        }}
      >
        <SelectTrigger aria-label="Sort workflows" className="w-auto min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORTS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
