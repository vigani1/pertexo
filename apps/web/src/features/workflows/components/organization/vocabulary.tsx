import {
  useState,
  useOptimistic,
  startTransition,
  type Ref,
  type ReactNode,
} from 'react';
import type { WorkflowFolder, WorkflowTag } from '@pertexo/contracts';
import { workflowOrganizationNameQuerySchema } from '@pertexo/contracts';
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
import type { ApiClient } from '@/lib/api/client';
import {
  workflowFoldersQueryOptions,
  workflowTagsInfiniteQueryOptions,
} from '../../data/organization/queries';
import type { updateWorkflowListSearch } from '../../model/list-view';
import type { WorkflowListSearch } from '../../model/list-view';
import { workflowFolderOptions } from '../../model/organization/folder-navigation';
import {
  isOrganizationReadDenied,
  useOrganizationReadLifetime,
} from '../../hooks/use-organization-read-lifetime';

export function OrganizationNameFilter({
  query,
  filterRef,
  onChange,
}: Readonly<{
  query: string;
  filterRef: Ref<HTMLInputElement>;
  onChange: (query: string | null) => void | Promise<void>;
}>) {
  const [optimisticQuery, setOptimisticQuery] = useOptimistic(query);
  const [error, setError] = useState<string>();
  return (
    // The placeholder says what the box is; like the Runs search, the label
    // is for screen readers only.
    <LabelledField
      id="workflow-organization-query"
      label="Search workflows"
      className="[&_[data-slot=field-label]]:sr-only"
      error={error}
    >
      {(control) => (
        <Input
          {...control}
          ref={filterRef}
          type="search"
          name="query"
          placeholder="Search workflows…"
          autoComplete="off"
          value={optimisticQuery}
          onChange={(event) => {
            const value = event.target.value;
            if (!workflowOrganizationNameQuerySchema.safeParse(value).success) {
              setError('Use a shorter search.');
              return;
            }
            setError(undefined);
            startTransition(async () => {
              setOptimisticQuery(value);
              await onChange(value === '' ? null : value);
            });
          }}
        />
      )}
    </LabelledField>
  );
}

/** Own the authorized vocabulary lifetime independently of whether its popup is open. */
export function useWorkflowFilterVocabulary(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  const lifetime = useOrganizationReadLifetime(userId, workspaceId);
  const folders = useQuery({
    ...workflowFoldersQueryOptions(apiClient, userId, workspaceId),
    enabled: lifetime.error === undefined,
  });
  const tags = useInfiniteQuery({
    ...workflowTagsInfiniteQueryOptions(apiClient, userId, workspaceId),
    enabled: lifetime.error === undefined,
  });
  const denied =
    lifetime.error !== undefined ||
    isOrganizationReadDenied(folders.error) ||
    isOrganizationReadDenied(tags.error);
  return {
    folders: denied ? undefined : folders.data?.items,
    tags: denied ? undefined : tags.data?.pages.flatMap((page) => page.items),
    denied,
    failed: denied || folders.isError || tags.isError,
    showing: folders.data !== undefined || tags.data !== undefined,
    hasMoreTags: !denied && tags.hasNextPage,
    loadingTags: tags.isFetchingNextPage,
    failedNextTags: tags.isFetchNextPageError,
    loadMoreTags: () => void tags.fetchNextPage(),
    retry: () => {
      void Promise.all([folders.refetch(), tags.refetch()]).then((results) => {
        if (results.every((result) => result.isSuccess)) lifetime.restore();
      });
    },
  };
}

export function WorkflowFilterChoices({
  folders,
  tags,
  search,
  onChange: change,
  onFavoritesChange,
  onManage,
  children,
}: Readonly<{
  folders: readonly WorkflowFolder[] | undefined;
  tags: readonly WorkflowTag[] | undefined;
  search: WorkflowListSearch;
  onChange: (change: Parameters<typeof updateWorkflowListSearch>[1]) => void;
  onFavoritesChange: () => void;
  onManage?: () => void;
  children: ReactNode;
}>) {
  return (
    <>
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
      <OrganizationVocabularyControls
        folders={folders}
        tags={tags}
        search={search}
        onChange={change}
      />
      <Button
        type="button"
        variant="outline"
        aria-pressed={search.favoritesOnly === 'true'}
        onClick={onFavoritesChange}
      >
        My favorites
      </Button>
      {children}
      <Button
        variant="ghost"
        onClick={() => {
          change({
            view: 'active',
            query: null,
            tagId: null,
            folderId: null,
            favoritesOnly: null,
          });
        }}
      >
        Clear filters
      </Button>
      {onManage === undefined ? null : (
        <Button variant="outline" onClick={onManage}>
          Manage tags…
        </Button>
      )}
    </>
  );
}

function OrganizationVocabularyControls({
  folders,
  tags,
  search,
  onChange: change,
}: Readonly<{
  folders: readonly WorkflowFolder[] | undefined;
  tags: readonly WorkflowTag[] | undefined;
  search: WorkflowListSearch;
  onChange: (change: Parameters<typeof updateWorkflowListSearch>[1]) => void;
}>) {
  const folderItems = [
    { value: 'all', label: 'All folders' },
    { value: 'root', label: 'Unfiled' },
    ...workflowFolderOptions(folders ?? []),
  ];
  const tagItems = [
    { value: 'all', label: 'All tags' },
    ...(tags ?? []).map((tag) => ({
      value: tag.id,
      label: tag.key,
    })),
  ];
  return (
    <>
      <Select
        items={folderItems}
        value={search.folderId ?? 'all'}
        disabled={folders === undefined}
        onValueChange={(value) => {
          if (typeof value === 'string')
            change({ folderId: value === 'all' ? null : value });
        }}
      >
        <SelectTrigger aria-label="Filter by folder" className="w-full">
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
        disabled={tags === undefined}
        onValueChange={(value) => {
          if (typeof value === 'string')
            change({ tagId: value === 'all' ? null : value });
        }}
      >
        <SelectTrigger aria-label="Filter by tag" className="w-full">
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
    </>
  );
}

export function OrganizationVocabularyReadFailure({
  denied,
  showing,
  onRetry,
}: Readonly<{
  denied: boolean;
  showing: boolean;
  onRetry: () => void;
}>) {
  return (
    <Notice
      tone="warning"
      action={
        <Button variant="ghost" onClick={onRetry}>
          Retry folders and tags
        </Button>
      }
    >
      {denied
        ? 'Access changed. Cached folders and tags were forgotten. Retry to read current authorized metadata.'
        : showing
          ? 'Folders or tags couldn’t be refreshed. Showing the last authorized vocabulary; it may be stale.'
          : 'Folders or tags couldn’t be read.'}{' '}
      Existing filters remain in the URL; missing metadata is not an empty
      vocabulary.
    </Notice>
  );
}
