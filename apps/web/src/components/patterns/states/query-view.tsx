import { ReadRecovery } from './read-recovery';
import { useReadRetry } from '@/lib/hooks/use-read-retry';
import type { ReactNode } from 'react';
import { StaleLine } from '@/components/patterns/states/stale-line';
import {
  Empty,
  EmptyActions,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Notice } from '@/components/ui/notice';
import { SkeletonLines } from '@/components/ui/skeleton';
import { StatusGlyph } from '@/components/ui/status';
import { readFailureReason, shownData } from '@/lib/api/error-copy';

/** What a feature's own failure explanation needs to keep Retry working. */
export type ReadFailureRecovery = Readonly<{
  resource: string;
  retrying: boolean;
  retry: () => void;
}>;

/** The part of a TanStack query result that decides what a read shows. */
export type ReadQuery<Data> = Readonly<{
  data: Data | undefined;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  error: unknown;
  dataUpdatedAt: number;
  refetch: () => unknown;
  /** Infinite queries: a failed next page belongs to `LoadMore`, not here. */
  isFetchNextPageError?: boolean;
}>;

/**
 * The one owner of a read's states. Before data arrives it shows `loading`
 * or a failure notice with Retry; once data is on screen a failed refresh
 * keeps it and adds the amber stale line, unless the answer says access is
 * gone (signed out, forbidden, not found), which hides it. `empty` replaces
 * the content when `isEmpty` says the data has nothing in it. Without
 * `children` it renders only the states, for data the caller already shows
 * elsewhere, such as the options of a select.
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
  failure?: (error: unknown, recovery: ReadFailureRecovery) => ReactNode;
  children?: (data: Data) => ReactNode;
}>) {
  const waitSeconds = useReadRetry(query.error);
  const retry = () => {
    if (waitSeconds === 0 && !query.isFetching) void query.refetch();
  };
  if (query.isError) {
    const explained = failure?.(query.error, {
      resource,
      retrying: query.isFetching,
      retry,
    });
    if (explained !== undefined && explained !== null) return explained;
  }
  // An authoritative "you can't see this" hides data loaded earlier.
  const data = shownData(query);
  if (data === undefined) {
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
      <Notice tone="destructive">
        <ReadRecovery
          error={query.error}
          resource={resource}
          retrying={query.isFetching}
          retry={retry}
        />
      </Notice>
    );
  }
  const showEmpty = empty !== undefined && (isEmpty?.(data) ?? false);
  const content = showEmpty ? empty : children?.(data);
  const refreshFailed = query.isError && !query.isFetchNextPageError;
  // One shape either way, so a failed refresh never remounts the content
  // and its unsaved edits.
  return (
    <>
      {refreshFailed ? (
        <StaleLine
          updatedAt={query.dataUpdatedAt}
          retrying={query.isFetching}
          onRetry={retry}
          error={query.error}
        />
      ) : null}
      {content}
    </>
  );
}

/**
 * A list page's own failed first read, for `QueryView`'s `error`: the
 * title says what didn't load, the sentence why, and one Try again.
 */
export function FailedReadState({
  title,
  error,
  retrying,
  retry,
}: Readonly<{
  /** "Members couldn’t be loaded". */
  title: string;
  error: unknown;
  retrying: boolean;
  retry: () => void;
}>) {
  return (
    <Empty>
      <EmptyMedia>
        <StatusGlyph tone="failure" className="size-6" />
      </EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyActions>
        <ReadRecovery
          error={error}
          resource={title}
          retrying={retrying}
          retry={retry}
          message={readFailureReason(error)}
          label="Try again"
        />
      </EmptyActions>
    </Empty>
  );
}

/**
 * A small value's failed first read, for `QueryView`'s `error` where a
 * notice would outweigh the value, such as one field of a run.
 */
export function InlineFailedRead({
  text,
  error,
  retrying,
  retry,
}: Readonly<{
  text: string;
  error: unknown;
  retrying: boolean;
  retry: () => void;
}>) {
  return (
    <div role="alert" className="text-label text-muted-foreground">
      <ReadRecovery
        error={error}
        resource="This data"
        message={text}
        retrying={retrying}
        retry={retry}
        label="Try again"
      />
    </div>
  );
}
