import {
  useState,
  useOptimistic,
  startTransition,
  type Ref,
  type ReactNode,
} from 'react';
import type { WorkflowFolder, WorkflowTag } from '@pertexo/contracts';
import { workflowOrganizationNameQuerySchema } from '@pertexo/contracts';
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
import type { updateWorkflowListSearch } from '../../model/list-view';
import type { WorkflowListSearch } from '../../model/list-view';
import { workflowFolderOptions } from '../../model/organization/folder-navigation';

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
            {VIEW_LABELS[view]}
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
      {vocabularyFailure({ denied, showing })} Existing filters remain in the
      URL; missing metadata is not an empty vocabulary.
    </Notice>
  );
}

const VIEW_LABELS = {
  active: 'Active',
  archived: 'Archived',
  all: 'All',
} as const;

function vocabularyFailure({
  denied,
  showing,
}: Readonly<{ denied: boolean; showing: boolean }>): string {
  if (denied)
    return 'Access changed. Cached folders and tags were forgotten. Retry to read current authorized metadata.';
  return showing
    ? 'Folders or tags couldn’t be refreshed. Showing the last authorized vocabulary; it may be stale.'
    : 'Folders or tags couldn’t be read.';
}
