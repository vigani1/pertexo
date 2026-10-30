import { LoadMore } from '@/components/patterns/lists/load-more';
import { QueryView } from '@/components/patterns/states/query-view';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type {
  ApiTokenListResponse,
  ApiTokenMetadata,
} from '@pertexo/contracts';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { TokenList } from './list';

export function TokenResults({
  query,
  onRevoke,
}: Readonly<{
  query: UseInfiniteQueryResult<InfiniteData<ApiTokenListResponse>>;
  onRevoke?: (token: ApiTokenMetadata) => void;
}>) {
  return (
    <>
      <QueryView
        query={query}
        resource="API tokens"
        loading={<Skeleton className="h-24 w-full" />}
        isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
        empty={
          <div className="flex flex-col gap-3 py-5">
            <Status tone="neutral">No API tokens yet</Status>
            <p className="text-sm text-muted-foreground">
              Create one for the script you want to connect, with only the
              scopes it needs.
            </p>
          </div>
        }
      >
        {(data) => (
          <TokenList
            tokens={data.pages.flatMap((page) => page.items)}
            {...(onRevoke === undefined ? {} : { onRevoke })}
          />
        )}
      </QueryView>
      <LoadMore
        subject="tokens"
        label="Load more tokens"
        hasNextPage={query.hasNextPage}
        loading={query.isFetchingNextPage}
        failed={query.isFetchNextPageError}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </>
  );
}
