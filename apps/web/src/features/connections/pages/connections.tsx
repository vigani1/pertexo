import { LooseThread } from '@/components/patterns/states/thread-illustrations';
import {
  FailedReadState,
  QueryView,
} from '@/components/patterns/states/query-view';
import { SkeletonRows } from '@/components/ui/skeleton';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
  ConnectionResponse,
} from '@pertexo/contracts';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useEffect, type ComponentProps } from 'react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { HowItWorks } from '@/components/patterns/guidance/how-it-works';
import { UnavailablePage } from '@/components/patterns/states/unavailable-page';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Status } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { AddConnectionSheet } from '../components/add-connection/sheet';
import { ConnectionCollection } from '../components/connection-collection';
import { ConnectionDetailSheet } from '../components/detail/sheet';
import { ProviderSockets } from '../components/provider-sockets';
import {
  connectionKeys,
  connectionsInfiniteQueryOptions,
} from '../data/connections.queries';
import { connectionAccessLost } from '../model/connection-access';
import type { ConnectionsSearch } from '../model/connections-search';
import { roleLimitSentence, whoCan } from '@/features/workspaces/roles.public';
import { sentenceStart } from '@/lib/format/sentence';

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
  return (
    <QueryView
      query={connections}
      resource="Connections"
      loading={<SkeletonRows label="Loading connections" />}
      error={(failed) => (
        <FailedReadState title="Connections couldn’t be loaded" {...failed} />
      )}
      isEmpty={() => items.length === 0}
      empty={
        <Empty>
          <EmptyMedia className="w-full max-w-56">
            <LooseThread />
          </EmptyMedia>
          <EmptyTitle>Nothing connected yet</EmptyTitle>
          <EmptyDescription>
            {canManage
              ? 'Pick a service above. Workflows can use a connection as soon as it’s saved.'
              : `${sentenceStart(whoCan('connection:manage'))} can connect Slack, HTTPS APIs and email here.`}
          </EmptyDescription>
        </Empty>
      }
    >
      {() => (
        <ConnectionCollection
          query={connections}
          items={items}
          {...collection}
        />
      )}
    </QueryView>
  );
}

/**
 * Where Pertexo plugs into Slack, HTTPS APIs and email — and whether each
 * connection still works. Lenses (add, detail) and the revoked view are URL
 * state owned by the route.
 */
type ConnectionsPageProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  search: ConnectionsSearch;
  onSearchChange: (next: ConnectionsSearch) => void;
}>;

export function ConnectionsPage(props: ConnectionsPageProps) {
  return (
    <ConnectionsSession
      key={`${props.user.id}:${props.workspace.id}:${props.workspace.status}:${props.workspace.capabilities.join(',')}`}
      {...props}
    />
  );
}

function ConnectionsSession({
  apiClient,
  user,
  workspace,
  search,
  onSearchChange,
}: ConnectionsPageProps) {
  const canRead = workspace.capabilities.includes('connection:read');
  const canTest = workspace.capabilities.includes('connection:use');
  const canManage = workspace.capabilities.includes('connection:manage');
  const canReadUsage = workspace.capabilities.includes('workflow:read');
  const cache = useQueryClient();
  useEffect(() => {
    const queryKey = connectionKeys.scope(user.id, workspace.id);
    if (!canRead || workspace.status !== 'active') {
      void cache.cancelQueries({ queryKey }).then(() => {
        cache.removeQueries({ queryKey });
      });
    } else if (!canReadUsage) {
      const predicate = (query: { queryKey: readonly unknown[] }) =>
        query.queryKey.at(-2) === 'usage';
      void cache.cancelQueries({ queryKey, predicate }).then(() => {
        cache.removeQueries({ queryKey, predicate });
      });
    }
  }, [cache, canRead, canReadUsage, user.id, workspace.id, workspace.status]);
  const connections = useInfiniteQuery({
    ...connectionsInfiniteQueryOptions(apiClient, user.id, workspace.id),
    enabled: canRead && workspace.status === 'active',
  });
  const scope = { apiClient, userId: user.id, workspaceId: workspace.id };
  const items = connections.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = countByStatus(items);

  if (!canRead || workspace.status !== 'active')
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
  if (
    connections.isError &&
    isApiError(connections.error) &&
    connections.error.problem?.code === 'connection.not_configured'
  )
    return (
      <UnavailablePage
        heading="Connections"
        title="Connections need server configuration"
        description="This server has no connection encryption provider configured. Enable local connection encryption for development, or configure AWS KMS on the server. Alerts need a connection too."
      />
    );
  if (connections.isError && connectionAccessLost(connections.error))
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

      <HowItWorks
        title="How connections work"
        className="border-t border-border pt-8"
        steps={[
          {
            title: 'Connect a service',
            body: 'Add a Slack bot token, an API’s headers, a Resend API key or a signing key. It’s stored encrypted, and nobody, including you, can see it again.',
          },
          {
            title: 'Keep it working',
            body: 'Test it from its page to see the service still answers, and replace the secret there when it changes.',
          },
          {
            title: 'Use it in steps and alerts',
            body: 'Steps such as HTTP request, Send Slack message, Send email and HMAC signature pick a connection, and so do Slack and email alerts.',
          },
        ]}
      />

      <ConnectionDetailSheet
        scope={scope}
        connectionId={search.connection}
        placeholder={items.find((item) => item.id === search.connection)}
        permissions={{ canTest, canManage, canReadUsage }}
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
