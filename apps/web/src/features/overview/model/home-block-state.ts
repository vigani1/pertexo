/** What a Home block shows: its loading, failure and staleness. */
export type HomeBlockState = Readonly<{
  pending: boolean;
  /** The failure of the latest read, if it failed. */
  error: unknown;
  failed: boolean;
  hasData: boolean;
  retrying: boolean;
  updatedAt: number;
  onRetry: () => void;
}>;

/** The parts of a query (plain or infinite) a Home block reads. */
export type BlockQuery = Readonly<{
  data: unknown;
  dataUpdatedAt: number;
  error: unknown;
  isError: boolean;
  isPending: boolean;
  isRefetching: boolean;
  refetch: () => Promise<unknown>;
}>;

/** A block backed by one query. */
export function queryBlockState(query: BlockQuery): HomeBlockState {
  return mergedBlockState(query, []);
}

/**
 * A block that merges several reads: its evidence is complete when all have data,
 * and any failed read shows the retry, which re-reads only the failed ones.
 */
export function mergedBlockState(
  main: BlockQuery,
  others: readonly BlockQuery[],
): HomeBlockState {
  const all = [main, ...others];
  const failed = all.filter((query) => query.isError);
  return {
    pending: all.some((query) => query.isPending),
    error: failed[0]?.error,
    failed: failed.length > 0,
    hasData: all.every((query) => query.data !== undefined),
    retrying: all.some((query) => query.isRefetching),
    updatedAt: Math.min(...all.map((query) => query.dataUpdatedAt)),
    onRetry: () => {
      for (const query of failed) void query.refetch();
    },
  };
}
