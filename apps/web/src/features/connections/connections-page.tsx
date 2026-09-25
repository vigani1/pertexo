import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { useInfiniteQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { UnavailablePage } from '@/components/patterns/unavailable-page';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/ui/empty';
import { Status } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { describeReadError, isNotFound } from '@/lib/api/api-error-copy';
import { AddConnectionSheet } from './components/add-connection/add-connection-sheet';
import { ConnectionCollection } from './components/connection-collection';
import { ConnectionDetailSheet } from './components/detail/connection-detail-sheet';
import { ProviderSockets } from './components/provider-sockets';
import { connectionsInfiniteQueryOptions } from './connections.queries';
import type { ConnectionsSearch } from './model/connections-search';
import { roleLimitSentence } from '@/features/workspaces/roles.public';

function countByStatus(items: readonly ConnectionResponse[]) {
  let active = 0;
  let reconnect = 0;
  let revoked = 0;
  for (const item of items) {
    if (item.status === 'active') active += 1;
    else if (item.status === 'revoked') revoked += 1;
    else reconnect += 1;
  }
  return { active, reconnect, revoked } as const;
}

/** The title, how many connections work, and Add for people who manage them. */
function ConnectionsHeader({
  counts,
  hasConnections,
  canManage,
  onAdd,
}: Readonly<{
  counts: ReturnType<typeof countByStatus>;
  hasConnections: boolean;
  canManage: boolean;
  onAdd: () => void;
}>) {
  return (
    <PageHeader>
      <div>
        <PageHeaderTitle>Connections</PageHeaderTitle>
        {hasConnections ? (
          <PageHeaderMeta>
            <span>
              <b className="text-foreground">{counts.active}</b> active
            </span>
            {counts.reconnect > 0 ? (
              <Status tone="attention">
                {counts.reconnect} needs reconnecting
              </Status>
            ) : null}
          </PageHeaderMeta>
        ) : null}
      </div>
      {canManage ? (
        <PageHeaderActions>
          <Button type="button" variant="primary" onClick={onAdd}>
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Add connection
          </Button>
        </PageHeaderActions>
      ) : null}
    </PageHeader>
  );
}

/** The list, or why there is none: it failed to load, or nothing is connected. */
function ConnectionsBody({
  connections,
  items,
  canManage,
  ...collection
}: Readonly<
  Omit<ComponentProps<typeof ConnectionCollection>, 'query'> & {
    connections: ComponentProps<typeof ConnectionCollection>['query'];
    canManage: boolean;
  }
>) {
  if (connections.isError && items.length === 0)
    return (
      <Empty>
        <EmptyTitle>Connections couldn’t be loaded</EmptyTitle>
        <EmptyDescription>
          {describeReadError(connections.error, 'Connections')}
        </EmptyDescription>
        <EmptyActions>
          <Button
            type="button"
            variant="outline"
            onClick={() => void connections.refetch()}
          >
            Try again
          </Button>
        </EmptyActions>
      </Empty>
    );
  if (connections.isSuccess && items.length === 0)
    return (
      <Empty>
        <EmptyTitle>Nothing connected yet</EmptyTitle>
        <EmptyDescription>
          {canManage
            ? 'Pick a service above. Workflows can use a connection as soon as it’s saved.'
            : 'Admins and owners can connect Slack, HTTPS APIs and email here.'}
        </EmptyDescription>
      </Empty>
    );
  return (
    <ConnectionCollection query={connections} items={items} {...collection} />
  );
}

/**
 * Where Pertexo plugs into Slack, HTTPS APIs and email — and whether each
 * connection still works. Lenses (add, detail) and the revoked view are URL
 * state owned by the route.
 */
export function ConnectionsPage({
  apiClient,
  user,
  workspace,
  search,
  onSearchChange,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  search: ConnectionsSearch;
  onSearchChange: (next: ConnectionsSearch) => void;
}>) {
  const canRead = workspace.capabilities.includes('connection:read');
  const canTest = workspace.capabilities.includes('connection:use');
  const canManage = workspace.capabilities.includes('connection:manage');
  const connections = useInfiniteQuery({
    ...connectionsInfiniteQueryOptions(apiClient, user.id, workspace.id),
    enabled: canRead,
  });
  const scope = { apiClient, userId: user.id, workspaceId: workspace.id };
  const items = connections.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = countByStatus(items);

  if (!canRead)
    return (
      <UnavailablePage
        heading="Connections"
        title="Connections are unavailable"
        description={roleLimitSentence(
          workspace.role,
          'connection:read',
          'see this workspace’s connections',
        )}
      />
    );
  if (connections.isError && isNotFound(connections.error))
    return (
      <UnavailablePage
        heading="Connections"
        title="Connections are unavailable"
        description="This workspace’s connections don’t exist, or you don’t have access to them."
      />
    );

  const openAdd = (add: NonNullable<ConnectionsSearch['add']>) => {
    onSearchChange({ ...search, add });
  };
  const withoutLens = {
    ...(search.view === undefined ? {} : { view: search.view }),
  };

  return (
    <div className="flex flex-col gap-8">
      <ConnectionsHeader
        counts={counts}
        hasConnections={items.length > 0}
        canManage={canManage}
        onAdd={() => {
          openAdd('any');
        }}
      />

      {canManage ? <ProviderSockets onConnect={openAdd} /> : null}

      <ConnectionsBody
        connections={connections}
        items={items}
        revokedCount={counts.revoked}
        canManage={canManage}
        view={search.view === 'revoked' ? 'revoked' : 'current'}
        onViewChange={(view) => {
          onSearchChange(view === 'revoked' ? { view: 'revoked' } : {});
        }}
        onOpen={(connection) => {
          onSearchChange({ ...withoutLens, connection });
        }}
      />

      <ConnectionDetailSheet
        scope={scope}
        connectionId={search.connection}
        placeholder={items.find((item) => item.id === search.connection)}
        permissions={{ canTest, canManage }}
        onClose={() => {
          onSearchChange(withoutLens);
        }}
      />
      {canManage ? (
        <AddConnectionSheet
          scope={scope}
          workspaceName={workspace.name}
          request={search.add}
          onClose={() => {
            onSearchChange(withoutLens);
          }}
        />
      ) : null}
    </div>
  );
}
