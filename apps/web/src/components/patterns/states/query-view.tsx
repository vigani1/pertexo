import type { ReactNode } from 'react';
import { RotateCcwIcon } from 'lucide-react';
import { StaleLine } from '@/components/patterns/states/stale-line';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { SkeletonLines } from '@/components/ui/skeleton';
import { describeReadError } from '@/lib/api/error-copy';

/** The part of a TanStack query result that decides what a read shows. */
export type ReadQuery<Data> = Readonly<{
  data: Data | undefined;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  error: unknown;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
  /** Infinite queries: a failed next page belongs to `LoadMore`, not here. */
  isFetchNextPageError?: boolean;
}>;

/**
 * The one owner of a read's states. Before data arrives it shows `loading`
 * or a failure notice with Retry; once data is on screen a failed refresh
 * keeps it and adds the amber stale line. `empty` replaces the content when
 * `isEmpty` says the data has nothing in it. Without `children` it renders
 * only the states, for data the caller already shows elsewhere, such as the
 * options of a select.
 */
export function QueryView<Data>({
  query,
  resource,
  loading,
  error,
  isEmpty,
  empty,
  failure,
  children,
}: Readonly<{
  query: ReadQuery<Data>;
  /** What is being read, for the sentences: "Recent deliveries". */
  resource: string;
  /** Defaults to two spooling lines announced as "Loading <resource>". */
  loading?: ReactNode;
  /**
   * Replaces the failure notice shown before any data arrived, for a page
   * with its own designed failure state.
   */
  error?: (
    failed: Readonly<{ error: unknown; retrying: boolean; retry: () => void }>,
  ) => ReactNode;
  isEmpty?: (data: Data) => boolean;
  empty?: ReactNode;
  /**
   * A failure the feature explains itself, such as lost access. What it
   * returns replaces the data, even data loaded earlier.
   */
  failure?: (error: unknown) => ReactNode;
  children?: (data: Data) => ReactNode;
}>) {
  const retry = () => void query.refetch();
  if (query.isError) {
    const explained = failure?.(query.error);
    if (explained !== undefined && explained !== null) return explained;
  }
  if (query.data === undefined) {
    if (query.isPending)
      return (
        loading ?? (
          <SkeletonLines
            label={`Loading ${resource.toLowerCase()}`}
            lines={2}
          />
        )
      );
    if (!query.isError) return null;
    if (error !== undefined)
      return error({
        error: query.error,
        retrying: query.isFetching,
        retry,
      });
    return (
      <Notice
        tone="destructive"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={retry}
          >
            <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
            {query.isFetching ? 'Trying again…' : 'Retry'}
          </Button>
        }
      >
        {describeReadError(query.error, resource)}
      </Notice>
    );
  }
  const showEmpty = empty !== undefined && (isEmpty?.(query.data) ?? false);
  const content = showEmpty ? empty : children?.(query.data);
  const refreshFailed = query.isError && !(query.isFetchNextPageError ?? false);
  if (!refreshFailed) return content;
  return (
    <>
      <StaleLine
        updatedAt={query.dataUpdatedAt}
        retrying={query.isFetching}
        onRetry={retry}
      />
      {content}
    </>
  );
}
