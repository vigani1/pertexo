import { useDeferredValue, useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type {
  FederationSettings,
  DirectoryAdoptionQuery,
} from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings-section';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { directoryPeopleQueryOptions } from '../../data/directory.queries';
import type { FederationScope } from '../../data/settings.api';
import { DirectoryAdoptionDialog } from './adoption-dialog';

export function DirectoryPeople({
  scope,
  organization,
  editable,
}: Readonly<{
  scope: FederationScope;
  organization: NonNullable<FederationSettings['organization']>;
  editable: boolean;
}>) {
  const id = useId(),
    [search, setSearch] = useState(''),
    searchQuery = useDeferredValue(search),
    [selectedWorkspaceId, setTargetWorkspaceId] = useState<string>(),
    [review, setReview] = useState<DirectoryAdoptionQuery>();
  const targetWorkspaceId = selectedWorkspaceId ?? scope.workspaceId;
  const people = useInfiniteQuery(
    directoryPeopleQueryOptions(scope, searchQuery),
  );
  const rows = people.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <SettingsSection
      title="Directory people"
      description="People remain pending until they complete verified organization SSO. Inactive and deleted records prevent JIT from restoring managed access. Existing manual memberships are adopted only after an explicit review."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <LabelledField id={`${id}-search`} label="Find a directory person">
          {(control) => (
            <Input
              {...control}
              type="search"
              maxLength={320}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              placeholder="Name or email"
            />
          )}
        </LabelledField>
        {editable ? (
          <LabelledField id={`${id}-workspace`} label="Workspace to review">
            {(control) => (
              <Select
                value={targetWorkspaceId}
                items={organization.workspaces.map((workspace) => ({
                  value: workspace.workspaceId,
                  label: workspace.name,
                }))}
                onValueChange={(value) => {
                  if (value !== null) setTargetWorkspaceId(value);
                }}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {organization.workspaces.map((workspace) => (
                    <SelectItem
                      key={workspace.workspaceId}
                      value={workspace.workspaceId}
                    >
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </LabelledField>
        ) : null}
      </div>
      {people.isPending ? <p role="status">Loading directory people…</p> : null}
      {people.isError ? (
        <Notice
          tone="warning"
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => void people.refetch()}
            >
              Retry people
            </Button>
          }
        >
          Directory people could not be loaded.
        </Notice>
      ) : null}
      {people.isFetching && !people.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Updating people…
        </p>
      ) : null}
      <ul className="divide-y divide-border" aria-label="Directory people">
        {rows.map((person) => (
          <li
            key={person.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
          >
            <div className="min-w-0">
              <p className="break-words font-medium">{person.userName}</p>
              <p className="break-all text-xs text-muted-foreground">
                {person.email}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {person.deleted
                  ? 'Deleted by directory'
                  : !person.active
                    ? 'Inactive'
                    : person.boundUserId === null
                      ? 'Awaiting first SSO'
                      : 'Active'}
              </p>
            </div>
            {editable &&
            person.active &&
            !person.deleted &&
            person.boundUserId !== null ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setReview({ directoryUserId: person.id, targetWorkspaceId });
                }}
              >
                Review membership for {person.userName}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {!people.isPending && !people.isError && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search.length === 0
            ? 'No directory people yet. Connect your identity provider to start provisioning.'
            : 'No directory people match this search.'}
        </p>
      ) : null}
      {people.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={people.isFetchingNextPage}
          onClick={() => void people.fetchNextPage()}
        >
          {people.isFetchingNextPage ? 'Loading more…' : 'Load more people'}
        </Button>
      ) : null}
      {review === undefined ? null : (
        <DirectoryAdoptionDialog
          scope={scope}
          input={review}
          onClose={() => {
            setReview(undefined);
          }}
        />
      )}
    </SettingsSection>
  );
}
