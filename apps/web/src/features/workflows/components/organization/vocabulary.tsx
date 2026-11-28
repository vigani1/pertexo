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
import { SearchInput } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/patterns/notices/inline-notice';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
        <SearchInput
          {...control}
          ref={filterRef}
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
  search,
  onChange: change,
  onFavoritesChange,
  onManage,
  children,
}: Readonly<{
  search: WorkflowListSearch;
  onChange: (change: Parameters<typeof updateWorkflowListSearch>[1]) => void;
  onFavoritesChange: () => void;
  onManage?: () => void;
  children: ReactNode;
}>) {
  return (
    <>
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
            publication: null,
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

export function OrganizationVocabularyControls({
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
        <SelectTrigger
          aria-label="Filter by folder"
          className="w-auto min-w-32 max-w-full"
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
        disabled={tags === undefined}
        onValueChange={(value) => {
          if (typeof value === 'string')
            change({ tagId: value === 'all' ? null : value });
        }}
      >
        <SelectTrigger
          aria-label="Filter by tag"
          className="w-auto min-w-32 max-w-full"
        >
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

function vocabularyFailure({
  denied,
  showing,
}: Readonly<{ denied: boolean; showing: boolean }>): string {
  if (denied)
    return 'Your access changed, so folders and tags were cleared. Retry to load the ones you can see.';
  return showing
    ? 'Folders or tags couldn’t be refreshed. These may be out of date.'
    : 'Folders or tags couldn’t be read.';
}
