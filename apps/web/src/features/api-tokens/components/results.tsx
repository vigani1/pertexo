import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type {
  ApiTokenListResponse,
  ApiTokenMetadata,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { describeReadError } from '@/lib/api/error-copy';
import { TokenList } from './list';

export function TokenResults({
  query,
  onRefresh,
  onRevoke,
}: Readonly<{
  query: UseInfiniteQueryResult<InfiniteData<ApiTokenListResponse>>;
  onRefresh: () => void;
  onRevoke: (token: ApiTokenMetadata) => void;
}>) {
  if (query.isPending) return <Skeleton className="h-24 w-full" />;
  const tokens = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      {!query.isError ? null : (
        <Notice
          tone="destructive"
          action={
            <Button variant="ghost" type="button" onClick={onRefresh}>
              Try again
            </Button>
          }
        >
          {describeReadError(query.error, 'API tokens')}
        </Notice>
      )}
      {query.data === undefined ? null : tokens.length === 0 ? (
        <div className="flex flex-col gap-3 py-5">
          <Status tone="neutral">No API tokens yet</Status>
          <p className="text-sm text-muted-foreground">
            Create one for the script you want to connect, with only the scopes
            it needs.
          </p>
        </div>
      ) : (
        <TokenList tokens={tokens} onRevoke={onRevoke} />
      )}
      {!query.hasNextPage ? null : (
        <Button
          type="button"
          variant="ghost"
          disabled={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more tokens'}
        </Button>
      )}
    </>
  );
}
