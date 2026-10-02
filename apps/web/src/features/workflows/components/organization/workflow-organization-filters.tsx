import { useState, type Ref } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { workflowOrganizationNameQuerySchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { LoadMore } from '@/components/patterns/load-more';
import type { ApiClient } from '@/lib/api/client';
import {
  workflowFoldersQueryOptions,
  workflowTagsInfiniteQueryOptions,
} from '../../organization.queries';
import {
  updateWorkflowListSearch,
  type WorkflowListSearch,
  type WorkflowListSearchUpdate,
} from '../../model/workflow-list-view';
import { WorkflowOrganizationManager } from './workflow-organization-manager';
import { workflowFolderOptions } from '../../model/workflow-folder-navigation';
import {
  isOrganizationReadDenied,
  useOrganizationReadLifetime,
} from '../../use-organization-read-lifetime';

function OrganizationNameFilter({
  value,
  filterRef,
  onChange,
}: Readonly<{
  value: string;
  filterRef: Ref<HTMLInputElement>;
  onChange: (query: string | null) => void;
}>) {
  const [query, setQuery] = useState(value);
  const [error, setError] = useState<string>();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = workflowOrganizationNameQuerySchema.safeParse(query);
        if (!parsed.success) {
          setError('Use at most 128 UTF-8 bytes for the name filter.');
          return;
        }
        setError(undefined);
        onChange(parsed.data === '' ? null : parsed.data);
      }}
    >
      <LabelledField
        id="workflow-organization-query"
        label="Name contains"
        error={error}
        description="Literal, case-sensitive matching across all workflows, not just loaded pages."
      >
        {(control) => (
          <Input
            {...control}
            ref={filterRef}
            type="search"
            name="query"
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        )}
      </LabelledField>
      <Button type="submit" variant="outline">
        Search
      </Button>
    </form>
  );
}

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
  onSearchChange: (search: WorkflowListSearchUpdate) => void;
}>) {
  const lifetime = useOrganizationReadLifetime(userId, workspace.id);
  const folders = useQuery({
    ...workflowFoldersQueryOptions(apiClient, userId, workspace.id),
    enabled: lifetime.error === undefined,
  });
  const tags = useInfiniteQuery({
    ...workflowTagsInfiniteQueryOptions(apiClient, userId, workspace.id),
    enabled: lifetime.error === undefined,
  });
  const denied =
    lifetime.error !== undefined ||
    isOrganizationReadDenied(folders.error) ||
    isOrganizationReadDenied(tags.error);
  const [managing, setManaging] = useState(false);
  const folderItems = [
    { value: 'all', label: 'All folders' },
    { value: 'root', label: 'Unfiled' },
    ...workflowFolderOptions(denied ? [] : (folders.data?.items ?? [])),
  ];
  const tagItems = [
    { value: 'all', label: 'All tags' },
    ...(denied
      ? []
      : (tags.data?.pages.flatMap((page) => page.items) ?? [])
    ).map((tag) => ({
      value: tag.id,
      label: tag.key,
    })),
  ];
  const change = (next: Parameters<typeof updateWorkflowListSearch>[1]) => {
    onSearchChange((current) => updateWorkflowListSearch(current, next));
  };
  return (
    <section
      aria-label="Find and organize workflows"
      className="flex flex-col gap-3"
    >
      <OrganizationNameFilter
        key={search.query ?? ''}
        value={search.query ?? ''}
        filterRef={filterRef}
        onChange={(query) => {
          change({ query });
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            change({
              query: null,
              tagId: null,
              folderId: null,
              favoritesOnly: null,
            });
          }}
        >
          Clear filters
        </Button>
        {workspace.role === 'owner' || workspace.role === 'admin' ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setManaging(true);
            }}
          >
            Manage folders and tags…
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="Which workflows to show"
          value={[search.view ?? 'active']}
          onValueChange={([view]) => {
            if (view === 'active' || view === 'archived' || view === 'all')
              change({ view });
          }}
        >
          {(['active', 'archived', 'all'] as const).map((view) => (
            <ToggleGroupItem key={view} value={view}>
              {view === 'active'
                ? 'Active'
                : view === 'archived'
                  ? 'Archived'
                  : 'All'}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Select
          items={folderItems}
          value={search.folderId ?? 'all'}
          disabled={denied || folders.data === undefined}
          onValueChange={(value) => {
            if (typeof value === 'string')
              change({ folderId: value === 'all' ? null : value });
          }}
        >
          <SelectTrigger
            aria-label="Filter by folder"
            className="w-auto min-w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {folderItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          items={tagItems}
          value={search.tagId ?? 'all'}
          disabled={denied || tags.data === undefined}
          onValueChange={(value) => {
            if (typeof value === 'string')
              change({ tagId: value === 'all' ? null : value });
          }}
        >
          <SelectTrigger aria-label="Filter by tag" className="w-auto min-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {tagItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          aria-pressed={search.favoritesOnly === 'true'}
          onClick={() => {
            onSearchChange((current) =>
              updateWorkflowListSearch(current, {
                favoritesOnly: current.favoritesOnly === 'true' ? null : 'true',
              }),
            );
          }}
        >
          My favorites
        </Button>
        <Select
          items={[
            { value: 'updated', label: 'Recently updated' },
            { value: 'created', label: 'Oldest first' },
          ]}
          value={search.sort ?? 'updated'}
          onValueChange={(sort) => {
            if (sort === 'updated' || sort === 'created') change({ sort });
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
      <LoadMore
        subject="tags"
        label="Load more tags"
        hasNextPage={!denied && tags.hasNextPage}
        loading={tags.isFetchingNextPage}
        failed={tags.isFetchNextPageError}
        onLoadMore={() => void tags.fetchNextPage()}
      />
      {denied || folders.isError || tags.isError ? (
        <Notice
          tone="warning"
          action={
            <Button
              variant="ghost"
              onClick={() => {
                void Promise.all([folders.refetch(), tags.refetch()]).then(
                  (results) => {
                    if (results.every((result) => result.isSuccess))
                      lifetime.restore();
                  },
                );
              }}
            >
              Retry folders and tags
            </Button>
          }
        >
          {denied
            ? 'Access changed. Cached folders and tags were forgotten. Retry to read current authorized metadata.'
            : folders.data !== undefined || tags.data !== undefined
              ? 'Folders or tags couldn’t be refreshed. Showing the last authorized vocabulary; it may be stale.'
              : 'Folders or tags couldn’t be read.'}{' '}
          Existing filters remain in the URL; missing metadata is not an empty
          vocabulary.
        </Notice>
      ) : null}
      {managing ? (
        <WorkflowOrganizationManager
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          onClose={() => {
            setManaging(false);
          }}
        />
      ) : null}
    </section>
  );
}
