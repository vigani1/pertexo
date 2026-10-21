import { useDeferredValue, useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { SharingPrincipals } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { sharingPrincipalsQueryOptions } from '@/lib/resource-sharing/principals.queries';
import { describeReadError } from '@/lib/api/error-copy';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
type Principal = SharingPrincipals['items'][number];
export function SharingPrincipalPicker({
  apiClient,
  userId,
  workspaceId,
  kind,
  selected,
  disabled,
  onAdd,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  kind: 'member' | 'group';
  selected: readonly string[];
  disabled: boolean;
  onAdd: (principal: Principal) => void;
}>) {
  const id = useId();
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const principals = useInfiniteQuery(
    sharingPrincipalsQueryOptions(
      apiClient,
      userId,
      workspaceId,
      kind,
      deferred,
    ),
  );
  const items = principals.data?.pages.flatMap((page) => page.items) ?? [];
  const selectedIds = new Set(selected);
  return (
    <div className="flex flex-col gap-3">
      <LabelledField
        id={id}
        label={kind === 'member' ? 'Find a member' : 'Find a directory group'}
      >
        {(control) => (
          <Input
            {...control}
            type="search"
            autoComplete="off"
            maxLength={128}
            value={search}
            disabled={disabled}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        )}
      </LabelledField>
      {principals.isError ? (
        <Notice tone="warning">
          {describeReadError(principals.error, 'Sharing choices')}{' '}
          <Button
            type="button"
            variant="outline"
            disabled={principals.isFetching}
            onClick={() => {
              void principals.refetch();
            }}
          >
            Retry
          </Button>
        </Notice>
      ) : (
        <PrincipalChoices
          kind={kind}
          items={items}
          selected={selectedIds}
          disabled={disabled}
          fetching={principals.isFetching}
          onAdd={onAdd}
        />
      )}
      {principals.isPending ? (
        <p role="status">Loading sharing choices…</p>
      ) : items.length === 0 && !principals.isError ? (
        <p className="text-sm text-subtle-foreground">
          No matching {kind === 'member' ? 'members' : 'directory groups'}.
        </p>
      ) : null}
      {principals.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || principals.isFetchingNextPage}
          onClick={() => {
            void principals.fetchNextPage();
          }}
        >
          More {kind === 'member' ? 'members' : 'groups'}
        </Button>
      ) : null}
    </div>
  );
}

function PrincipalChoices({
  kind,
  items,
  selected,
  disabled,
  fetching,
  onAdd,
}: Readonly<{
  kind: 'member' | 'group';
  items: readonly Principal[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  fetching: boolean;
  onAdd: (principal: Principal) => void;
}>) {
  return (
    <ul
      className="flex max-h-52 flex-col gap-1 overflow-y-auto"
      aria-label={kind === 'member' ? 'Members to add' : 'Groups to add'}
      aria-busy={fetching}
    >
      {items.map((principal) => {
        const identifier =
          principal.kind === 'member' ? principal.userId : principal.groupId;
        const added = selected.has(identifier);
        return (
          <li
            key={identifier}
            className="flex min-w-0 items-center justify-between gap-3 py-1"
          >
            <span className="min-w-0 wrap-anywhere">
              {principal.label}{' '}
              <span className="text-xs text-subtle-foreground">
                {identifier.slice(0, 8)}
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || added}
              aria-label={`Add ${principal.label}`}
              onClick={() => {
                onAdd(principal);
              }}
            >
              {added ? 'Added' : 'Add'}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
