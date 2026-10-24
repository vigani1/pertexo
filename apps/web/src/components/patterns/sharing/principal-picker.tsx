import { LoadMore } from '@/components/patterns/lists/load-more';
import { QueryView } from '@/components/patterns/states/query-view';
import { isAdministrativeRole } from '@pertexo/contracts';
import { useDeferredValue, useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CheckIcon, PlusIcon, SearchIcon } from 'lucide-react';
import type { SharingPrincipals } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { sharingPrincipalsQueryOptions } from '@/lib/resource-sharing/principals.queries';
import { principalIdentifier } from '@/lib/resource-sharing/principal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SharingEntry } from './entry';

type Principal = SharingPrincipals['items'][number];
type Kind = Principal['kind'];
type Role = Extract<Principal, { kind: 'member' }>['role'];

/**
 * Search people (and, where allowed, directory groups) to add. Owners and
 * admins already have access, so they're shown but can't be added.
 */
export function SharingPrincipalPicker({
  apiClient,
  userId,
  workspaceId,
  kinds,
  roleNames,
  selected,
  full,
  disabled,
  unavailable = () => undefined,
  onAdd,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  kinds: readonly Kind[];
  roleNames: Readonly<Record<Role, string>>;
  selected: readonly string[];
  /** The entry limit is reached; adding waits for a removal. */
  full: boolean;
  disabled: boolean;
  /** Why someone can't be added here, e.g. a role that can't use it. */
  unavailable?: (principal: Principal) => string | undefined;
  onAdd: (principal: Principal) => void;
}>) {
  const id = useId();
  const [kind, setKind] = useState<Kind>(kinds[0] ?? 'member');
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const principals = useInfiniteQuery(
    sharingPrincipalsQueryOptions({
      api: apiClient,
      userId,
      workspaceId,
      kind,
      search: deferred,
    }),
  );
  const items = principals.data?.pages.flatMap((page) => page.items) ?? [];
  const selectedIds = new Set(selected);
  const noun = kind === 'member' ? 'people' : 'groups';
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="text-sm font-medium">
          Add {kinds.length > 1 ? 'people or groups' : 'people'}
        </h3>
        {kinds.length > 1 ? (
          <ToggleGroup
            aria-label="Choose who to search"
            value={[kind]}
            onValueChange={([next]) => {
              if (next === 'member' || next === 'group') setKind(next);
            }}
          >
            <ToggleGroupItem value="member">People</ToggleGroupItem>
            <ToggleGroupItem value="group">Groups</ToggleGroupItem>
          </ToggleGroup>
        ) : null}
      </div>
      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label={
            kind === 'member'
              ? 'Search people by name or email'
              : 'Search directory groups'
          }
          placeholder={
            kind === 'member' ? 'Name or email' : 'Directory group name'
          }
          autoComplete="off"
          maxLength={128}
          className="pl-9"
          value={search}
          disabled={disabled}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </div>
      <QueryView
        query={principals}
        resource={kind === 'member' ? 'People' : 'Groups'}
        loading={
          <p role="status" className="py-3 text-sm text-muted-foreground">
            Looking for {noun}…
          </p>
        }
        isEmpty={() => items.length === 0}
        empty={
          <p className="py-3 text-sm text-muted-foreground">
            {noMatchSentence(kind, deferred)}
          </p>
        }
      >
        {() => (
          <ul
            className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border px-3"
            aria-label={kind === 'member' ? 'People to add' : 'Groups to add'}
            aria-busy={principals.isFetching}
          >
            {items.map((principal) => (
              <PrincipalChoice
                key={principalIdentifier(principal)}
                principal={principal}
                roleNames={roleNames}
                added={selectedIds.has(principalIdentifier(principal))}
                unavailable={unavailable(principal)}
                disabled={disabled || full}
                onAdd={onAdd}
              />
            ))}
          </ul>
        )}
      </QueryView>
      <LoadMore
        subject={noun}
        label={`Show more ${noun}`}
        hasNextPage={principals.hasNextPage}
        loading={principals.isFetchingNextPage}
        failed={principals.isFetchNextPageError}
        onLoadMore={() => {
          if (!disabled) void principals.fetchNextPage();
        }}
      />
    </section>
  );
}

function noMatchSentence(kind: Kind, search: string): string {
  if (search !== '')
    return `No ${kind === 'member' ? 'people' : 'groups'} match “${search}”.`;
  if (kind === 'member') return 'No other active members yet.';
  return 'No directory groups. Groups appear after single sign-on syncs them.';
}

function PrincipalChoice({
  principal,
  roleNames,
  added,
  unavailable,
  disabled,
  onAdd,
}: Readonly<{
  principal: Principal;
  roleNames: Readonly<Record<Role, string>>;
  added: boolean;
  unavailable: string | undefined;
  disabled: boolean;
  onAdd: (principal: Principal) => void;
}>) {
  const administrator =
    principal.kind === 'member' && isAdministrativeRole(principal.role);
  return (
    <SharingEntry
      kind={principal.kind}
      label={principal.label}
      detail={
        principal.kind === 'member'
          ? `${principal.email} · ${roleNames[principal.role]}`
          : 'Directory group'
      }
    >
      <PrincipalAction
        administrator={administrator}
        principal={principal}
        added={added}
        unavailable={unavailable}
        disabled={disabled}
        onAdd={onAdd}
      />
    </SharingEntry>
  );
}

function PrincipalAction({
  administrator,
  principal,
  added,
  unavailable,
  disabled,
  onAdd,
}: Readonly<{
  administrator: boolean;
  principal: Principal;
  added: boolean;
  unavailable: string | undefined;
  disabled: boolean;
  onAdd: (principal: Principal) => void;
}>) {
  if (administrator) {
    return (
      <span className="text-xs text-muted-foreground">Always has access</span>
    );
  }
  if (unavailable !== undefined) {
    return (
      <span className="text-right text-xs text-muted-foreground">
        {unavailable}
      </span>
    );
  }
  if (added) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <CheckIcon aria-hidden="true" className="size-3.5" />
        Added
      </span>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled}
      aria-label={`Add ${principal.label}`}
      onClick={() => {
        onAdd(principal);
      }}
    >
      <PlusIcon aria-hidden="true" />
      Add
    </Button>
  );
}
