import { QueryView } from '@/components/patterns/states/query-view';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { useDeferredValue, useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type {
  FederationSettings,
  DirectoryAdoptionQuery,
} from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings/section';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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

function personStatus(
  person: Readonly<{
    deleted: boolean;
    active: boolean;
    boundUserId: string | null;
  }>,
): string {
  if (person.deleted) return 'Deleted by directory';
  if (!person.active) return 'Inactive';
  if (person.boundUserId === null) return 'Awaiting first SSO';
  return 'Active';
}

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
      {people.isFetching && !people.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Updating people…
        </p>
      ) : null}
      <QueryView
        query={people}
        resource="Directory people"
        isEmpty={() => rows.length === 0}
        empty={
          <p className="text-sm text-muted-foreground">
            {search.length === 0
              ? 'No directory people yet. Connect your identity provider to start provisioning.'
              : 'No directory people match this search.'}
          </p>
        }
      >
        {() => (
          <ul className="divide-y divide-border" aria-label="Directory people">
            {rows.map((person) => {
              const canUnbindPerson =
                editable &&
                person.active &&
                !person.deleted &&
                person.boundUserId !== null;
              return (
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
                      {personStatus(person)}
                    </p>
                  </div>
                  {canUnbindPerson ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setReview({
                          directoryUserId: person.id,
                          targetWorkspaceId,
                        });
                      }}
                    >
                      Review membership for {person.userName}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </QueryView>
      <LoadMore
        subject="people"
        label="Load more people"
        hasNextPage={people.hasNextPage}
        loading={people.isFetchingNextPage}
        failed={people.isFetchNextPageError}
        onLoadMore={() => void people.fetchNextPage()}
      />
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
