import type {
  ConnectionListResponse,
  ConnectionResponse,
} from '@pertexo/contracts';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ConnectionList } from './connection-list';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';

type ConnectionsQuery = UseInfiniteQueryResult<
  InfiniteData<ConnectionListResponse>
>;

export function ConnectionCollection({
  query,
  items,
  revokedCount,
  view,
  onViewChange,
  selectedId,
  onOpen,
}: Readonly<{
  query: ConnectionsQuery;
  items: readonly ConnectionResponse[];
  revokedCount: number;
  view: 'current' | 'revoked';
  onViewChange: (view: 'current' | 'revoked') => void;
  selectedId: string | undefined;
  onOpen: (connectionId: string) => void;
}>) {
  const visible = items.filter((item) =>
    view === 'revoked' ? item.status === 'revoked' : item.status !== 'revoked',
  );
  return (
    <section aria-labelledby="your-connections" className="flex flex-col gap-2">
      <RuleHeading id="your-connections" count={visible.length}>
        {view === 'revoked' ? 'Revoked' : 'All'}
      </RuleHeading>
      <div className="flex flex-wrap items-center justify-between gap-3">
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
      {visible.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          {view === 'revoked'
            ? 'No revoked connections.'
            : 'Every connection here has been revoked. Add a new one to use it again.'}
        </p>
      ) : (
        <ConnectionList
          connections={visible}
          selectedId={selectedId}
          onOpen={onOpen}
        />
      )}
      <LoadMore
        subject="connections"
        hasNextPage={query.hasNextPage}
        loading={query.isFetchingNextPage}
        failed={query.isFetchNextPageError}
        error={query.error}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </section>
  );
}
