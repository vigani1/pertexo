import { useConnectionDefinitions } from '@/features/catalog/public';
import { connectionDefinition } from '../model/connection-providers';
import { useConnectionReadScope } from '../data/connection-read-scope';
import {
  isWorkspaceBrowsable,
  roleLimitSentence,
  whoCan,
} from '@/features/workspaces/public';
import { LooseThread } from '@/components/patterns/states/thread-illustrations';
import {
  FailedReadState,
  QueryView,
} from '@/components/patterns/states/query-view';
import { SkeletonRows } from '@/components/ui/skeleton';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
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
import { Status } from '@/components/patterns/status/status-mark';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { AddConnectionSheet } from '../components/add-connection/sheet';
import { ConnectionCollection } from '../components/connection-collection';
import { ConnectionDetailSheet } from '../components/detail/sheet';
import { ProviderSockets } from '../components/provider-sockets';
import { connectionsInfiniteQueryOptions } from '../data/connections.queries';
import { isReadAccessLost } from '@/lib/api/read-denial';
import type { ConnectionsSearch } from '../model/connections-search';
import { sentenceStart } from '@/lib/format/sentence';
import {
  countByStatus,
  type ConnectionCounts,
} from '../model/connection-counts';

/** The title, how many connections work, and Add for people who manage them. */
function ConnectionsHeader({
  counts,
  hasConnections,
  canManage,
  onAdd,
}: Readonly<{
  counts: ConnectionCounts;
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
  const canBrowse = canRead && isWorkspaceBrowsable(workspace);
  const canTest = workspace.capabilities.includes('connection:use');
  const canManage = workspace.capabilities.includes('connection:manage');
  const canReadUsage = workspace.capabilities.includes('workflow:read');
  useConnectionReadScope({
    userId: user.id,
    workspaceId: workspace.id,
    canBrowse,
    canReadUsage,
  });
  const connections = useInfiniteQuery({
    ...connectionsInfiniteQueryOptions(apiClient, user.id, workspace.id),
    enabled: canBrowse,
  });
  const scope = { apiClient, userId: user.id, workspaceId: workspace.id };
  const items = connections.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = countByStatus(items);
  const definitions = useConnectionDefinitions();

  if (!canBrowse)
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
  if (connections.isError && isReadAccessLost(connections.error))
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
            body: 'Add a Slack bot token, an API’s headers, a Resend API key, an SMTP login or a signing key. It’s stored encrypted, and nobody, including you, can see it again.',
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
        permissions={{
          canTest,
          canManage,
          canReadUsage,
          canFollow: workspace.status === 'active',
        }}
        onClose={() => {
          onSearchChange(withoutLens);
        }}
      />
      {canManage ? (
        <AddConnectionSheet
          scope={scope}
          workspaceName={workspace.name}
          request={
            search.add === 'any' ||
            connectionDefinition(definitions, search.add) !== undefined
              ? search.add
              : undefined
          }
          onClose={() => {
            onSearchChange(withoutLens);
          }}
        />
      ) : null}
    </div>
  );
}
