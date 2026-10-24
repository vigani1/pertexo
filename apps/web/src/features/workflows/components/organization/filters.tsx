import { isAdministrativeRole } from '@pertexo/workflow-model';
import { useState, type Ref } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { SlidersHorizontalIcon } from 'lucide-react';
import { LoadMore } from '@/components/patterns/lists/load-more';
import type { ApiClient } from '@/lib/api/client';
import {
  updateWorkflowListSearch,
  type WorkflowListSearch,
  type WorkflowListSearchUpdate,
} from '../../model/list-view';
import { WorkflowTagsDialog } from './tags/dialog';
import { OrganizationNameFilter } from './vocabulary';
import { useWorkflowFilterVocabulary } from './use-filter-vocabulary';
import { WorkflowFilterChoices } from './vocabulary';
import { OrganizationVocabularyReadFailure } from './vocabulary';

export function WorkflowOrganizationFilters({
  apiClient,
  userId,
  workspace,
  search,
  filterRef,
  onSearchChange,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  search: WorkflowListSearch;
  filterRef: Ref<HTMLInputElement>;
  onSearchChange: (search: WorkflowListSearchUpdate) => void | Promise<void>;
}>) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const filterCount = [
    search.view,
    search.folderId,
    search.tagId,
    search.favoritesOnly,
  ].filter((value) => value !== undefined).length;
  const vocabulary = useWorkflowFilterVocabulary(
    apiClient,
    userId,
    workspace.id,
  );
  const change = (next: Parameters<typeof updateWorkflowListSearch>[1]) => {
    return onSearchChange((current) => updateWorkflowListSearch(current, next));
  };
  return (
    <section
      aria-label="Find and organize workflows"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <OrganizationNameFilter
            query={search.query ?? ''}
            filterRef={filterRef}
            onChange={(query) => {
              return change({ query });
            }}
          />
        </div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={<Button variant="outline" />}>
            <SlidersHorizontalIcon aria-hidden="true" />
            Filters{filterCount === 0 ? '' : ` (${String(filterCount)})`}
          </PopoverTrigger>
          <PopoverContent className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-4">
            <PopoverTitle>Filter workflows</PopoverTitle>
            <WorkflowFilterChoices
              folders={vocabulary.folders}
              tags={vocabulary.tags}
              search={search}
              onChange={(next) => {
                void change(next);
              }}
              onFavoritesChange={() => {
                void onSearchChange((current) =>
                  updateWorkflowListSearch(current, {
                    favoritesOnly:
                      current.favoritesOnly === 'true' ? null : 'true',
                  }),
                );
              }}
              {...(isAdministrativeRole(workspace.role)
                ? {
                    onManage: () => {
                      setOpen(false);
                      setManaging(true);
                    },
                  }
                : {})}
            >
              <LoadMore
                subject="tags"
                label="Load more tags"
                hasNextPage={vocabulary.hasMoreTags}
                loading={vocabulary.loadingTags}
                failed={vocabulary.failedNextTags}
                onLoadMore={vocabulary.loadMoreTags}
              />
            </WorkflowFilterChoices>
          </PopoverContent>
        </Popover>
        <Select
          items={[
            { value: 'updated', label: 'Recently updated' },
            { value: 'created', label: 'Oldest first' },
          ]}
          value={search.sort ?? 'updated'}
          onValueChange={(sort) => {
            if (sort === 'updated' || sort === 'created') void change({ sort });
          }}
        >
          <SelectTrigger
            aria-label="Sort workflows"
            className="w-auto min-w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="updated">Recently updated</SelectItem>
              <SelectItem value="created">Oldest first</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {managing ? (
        <WorkflowTagsDialog
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          onClose={() => {
            setManaging(false);
          }}
        />
      ) : null}
      {vocabulary.failed ? (
        <OrganizationVocabularyReadFailure
          denied={vocabulary.denied}
          showing={vocabulary.showing}
          onRetry={vocabulary.retry}
        />
      ) : null}
    </section>
  );
}
