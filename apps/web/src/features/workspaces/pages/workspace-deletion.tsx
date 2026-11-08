import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { ReadRecovery } from '@/components/patterns/states/read-recovery';
import { accessibleWorkspacesQueryOptions } from '../data/workspaces.queries';

/** Mounted only after this session has observed the server's purging state. */
export function WorkspaceDeletionPage({
  apiClient,
  userId,
  workspaceId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>) {
  const discovery = useQuery({
    ...accessibleWorkspacesQueryOptions(apiClient, userId),
    refetchInterval: 5_000,
  });
  const finished =
    discovery.isSuccess &&
    !discovery.data.some((item) => item.id === workspaceId);
  return (
    <main
      id="main"
      className="grid min-h-svh place-items-center bg-background p-5"
    >
      <section className="flex max-w-lg flex-col items-start gap-4">
        <h1 className="text-xl font-semibold">
          {finished ? 'Deletion finished' : 'This workspace is being deleted'}
        </h1>
        <p>
          {finished
            ? 'Deletion finished. This workspace and its data are gone.'
            : 'Deletion is in progress. This page checks the latest status from the server.'}
        </p>
        {discovery.isError ? (
          <ReadRecovery
            error={discovery.error}
            resource="deletion status"
            retrying={discovery.isFetching}
            retry={() => {
              void discovery.refetch();
            }}
          />
        ) : null}
        {!finished && !discovery.isError ? (
          <Button
            variant="outline"
            disabled={discovery.isFetching}
            onClick={() => {
              void discovery.refetch();
            }}
          >
            Refresh deletion status
          </Button>
        ) : null}
        <Link to="/workspaces" className="underline">
          Choose a workspace
        </Link>
      </section>
    </main>
  );
}
