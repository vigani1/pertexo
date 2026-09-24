import type {
  ConnectionListResponse,
  ConnectionResponse,
} from '@pertexo/contracts/schemas/connections';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { LoadMore } from '@/components/patterns/load-more';
import { StaleLine } from '@/components/patterns/stale-line';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ConnectionList } from './connection-list';

type ConnectionsQuery = UseInfiniteQueryResult<
  InfiniteData<ConnectionListResponse>
>;

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
        <SkeletonRows label="Loading connections" />
      ) : visible.length === 0 ? (
        <p className="border-t border-border py-8 text-sm text-muted-foreground">
          {view === 'revoked'
            ? 'No revoked connections.'
            : 'Every connection here has been revoked. Add a new one to use it again.'}
        </p>
      ) : (
        <ConnectionList connections={visible} onOpen={onOpen} />
      )}
      <LoadMore
        subject="connections"
        hasNextPage={query.hasNextPage}
        loading={query.isFetchingNextPage}
        failed={query.isFetchNextPageError}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </section>
  );
}
