import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { connectionListErrorMessage } from './connection-errors';
import { ConnectionTable } from './components/connection-table';
import { CreateSlackConnectionDialog } from './components/create-slack-connection-dialog';
import { connectionsInfiniteQueryOptions } from './connections.queries';

export function ConnectionsPage({
  apiClient,
  user,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
}>) {
  const canRead = workspace.capabilities.includes('connection:read');
  const canTest = workspace.capabilities.includes('connection:use');
  const canManage = workspace.capabilities.includes('connection:manage');
  const connections = useInfiniteQuery({
    ...connectionsInfiniteQueryOptions(apiClient, user.id, workspace.id),
    enabled: canRead,
  });
  const items = connections.data?.pages.flatMap((page) => page.items) ?? [];
  const collectionUnavailable =
    connections.isError &&
    isApiError(connections.error) &&
    connections.error.status === 404;

  if (!canRead) {
    return (
      <Empty>
        <EmptyTitle>Connections are unavailable</EmptyTitle>
        <EmptyDescription>
          Your workspace role does not allow you to view stored connections.
        </EmptyDescription>
      </Empty>
    );
  }

  if (collectionUnavailable) {
    return (
      <Empty>
        <EmptyTitle>Connections are unavailable</EmptyTitle>
        <EmptyDescription>
          This collection is not available for the current workspace. It may not
          exist, be inactive, or be outside your account access.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <h1 className="sr-only text-3xl font-semibold tracking-tight lg:not-sr-only lg:block lg:text-4xl">
            Connections
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Manage the external accounts workflow nodes can use in{' '}
            {workspace.name}. Stored credentials are never displayed here.
          </p>
        </div>
        {canManage ? (
          <CreateSlackConnectionDialog
            key={`${user.id}:${workspace.id}:header`}
            apiClient={apiClient}
            userId={user.id}
            workspaceId={workspace.id}
          />
        ) : null}
      </div>

      {connections.isError &&
      items.length > 0 &&
      !connections.isFetchNextPageError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <p className="text-sm text-destructive">
            These connections may be stale because the latest refresh failed.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={connections.isRefetching}
            onClick={() => void connections.refetch()}
          >
            {connections.isRefetching ? 'Retrying…' : 'Retry refresh'}
          </Button>
        </div>
      ) : null}

      {connections.isPending ? (
        <p role="status" className="py-16 text-sm text-muted-foreground">
          Loading connections…
        </p>
      ) : connections.isError && items.length === 0 ? (
        <Empty>
          <EmptyTitle>Connections are unavailable</EmptyTitle>
          <EmptyDescription>
            {connectionListErrorMessage(connections.error)}
          </EmptyDescription>
          <Button
            className="mt-6"
            type="button"
            variant="outline"
            onClick={() => void connections.refetch()}
          >
            Try again
          </Button>
        </Empty>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyTitle>No connections yet</EmptyTitle>
          <EmptyDescription>
            Add a connection when a workflow needs permission to call an
            external service.
          </EmptyDescription>
          {canManage ? (
            <div className="mt-6">
              <CreateSlackConnectionDialog
                key={`${user.id}:${workspace.id}:empty`}
                apiClient={apiClient}
                userId={user.id}
                workspaceId={workspace.id}
                triggerLabel="Add the first connection"
              />
            </div>
          ) : null}
        </Empty>
      ) : (
        <>
          <div className="glass-panel overflow-hidden rounded-xl">
            <ConnectionTable
              connections={items}
              apiClient={apiClient}
              userId={user.id}
              workspaceId={workspace.id}
              canTest={canTest}
              canManage={canManage}
            />
          </div>
          {connections.hasNextPage ? (
            <div className="mt-6 flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={connections.isFetchingNextPage}
                onClick={() => void connections.fetchNextPage()}
              >
                {connections.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
          {connections.isFetchNextPageError ? (
            <p
              role="alert"
              className="mt-4 text-center text-sm text-destructive"
            >
              The next page could not be loaded. Try again.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
