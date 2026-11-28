import type { ReadQuery } from '@/components/patterns/states/query-view';
import { ReadRecovery } from '@/components/patterns/states/read-recovery';

export function paletteSearchState(query: ReadQuery<unknown>) {
  if (query.isPending) return { status: 'loading' as const };
  if (!query.isError) return { status: 'ready' as const };
  return {
    status: 'failed' as const,
    feedback: (
      <>
        {query.data === undefined ? null : (
          <p>Showing earlier search results.</p>
        )}
        <ReadRecovery
          error={query.error}
          resource="Workflow search"
          retrying={query.isFetching}
          retry={() => {
            void query.refetch();
          }}
        />
      </>
    ),
  };
}
