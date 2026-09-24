import type {
  ConnectionListResponse,
  ConnectionResponse,
} from '@pertexo/contracts/schemas/connections';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ConnectionList } from './connection-list';

type ConnectionsQuery = UseInfiniteQueryResult<
  InfiniteData<ConnectionListResponse>
>;

function ListSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading connections"
      className="flex flex-col gap-5 py-2"
    >
      {[64, 40, 78].map((width, order) => (
        <div
          key={width}
          className="grid grid-cols-[2rem_minmax(0,12rem)_minmax(0,1fr)] items-center gap-4"
        >
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="h-2.5" />
          <SkeletonThread
            order={order}
            style={{ width: `${String(width)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

export function ConnectionCollection({
  query,
  items,
  revokedCount,
  view,
  onViewChange,
  onOpen,
}: Readonly<{
  query: ConnectionsQuery;
  items: readonly ConnectionResponse[];
  revokedCount: number;
  view: 'current' | 'revoked';
  onViewChange: (view: 'current' | 'revoked') => void;
  onOpen: (connectionId: string) => void;
}>) {
  const visible = items.filter((item) =>
    view === 'revoked' ? item.status === 'revoked' : item.status !== 'revoked',
  );
  return (
    <section aria-labelledby="your-connections" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="your-connections" className="text-lg font-semibold">
          Your connections
        </h2>
        {revokedCount > 0 || view === 'revoked' ? (
          <ToggleGroup
            aria-label="Show"
            value={[view]}
            onValueChange={(next) => {
              const [selected] = next;
              if (selected === 'current' || selected === 'revoked')
                onViewChange(selected);
            }}
          >
            <ToggleGroupItem value="current">
              In use
              <span className="font-mono text-subtle-foreground">
                {items.length - revokedCount}
              </span>
            </ToggleGroupItem>
            <ToggleGroupItem value="revoked">
              Revoked
              <span className="font-mono text-subtle-foreground">
                {revokedCount}
              </span>
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
      </div>
      {query.isError && items.length > 0 && !query.isFetchNextPageError ? (
        <StaleLine
          updatedAt={query.dataUpdatedAt}
          retrying={query.isRefetching}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.isPending ? (
        <ListSkeleton />
      ) : visible.length === 0 ? (
        <p className="border-t border-border py-8 text-sm text-muted-foreground">
          {view === 'revoked'
            ? 'No revoked connections.'
            : 'Every connection here has been revoked. Add a new one to use it again.'}
        </p>
      ) : (
        <ConnectionList connections={visible} onOpen={onOpen} />
      )}
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          className="self-center"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? (
            <LoadingOrb data-icon="inline-start" />
          ) : null}
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
      {query.isFetchNextPageError ? (
        <p role="alert" className="text-center text-sm text-destructive">
          More connections couldn’t be loaded. Try again.
        </p>
      ) : null}
    </section>
  );
}
