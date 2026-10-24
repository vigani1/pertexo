import { useInfiniteQuery } from '@tanstack/react-query';
import type { WorkflowCommentListQuery } from '@pertexo/contracts';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { QueryView } from '@/components/patterns/states/query-view';
import { StatusGlyph } from '@/components/ui/status';
import type { CollaborationScope } from '../data/collaboration.api';
import { threadsQuery } from '../data/collaboration.queries';
export function DiscussionThreads({
  scope,
  filter,
  steps,
  onOpen,
}: {
  scope: CollaborationScope;
  filter: Pick<WorkflowCommentListQuery, 'status' | 'scope' | 'stepId'>;
  steps: readonly { id: string; label: string }[];
  onOpen: (threadId: string) => void;
}) {
  const query = useInfiniteQuery(threadsQuery(scope, filter));
  return (
    <>
      <QueryView
        query={query}
        resource="Discussions"
        isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
        empty={
          <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
            No discussions here yet. Start a thread when you have something to
            share.
          </p>
        }
      >
        {(data) => (
          <ul>
            {data.pages
              .flatMap((page) => page.items)
              .map((thread) => (
                <li key={thread.id} className="row-divider">
                  <button
                    type="button"
                    className="flex w-full gap-3 rounded-lg px-3 py-4 text-left transition-colors hover:bg-surface-ink/[0.035] focus-ring motion-reduce:transition-none"
                    onClick={() => {
                      onOpen(thread.id);
                    }}
                  >
                    <StatusGlyph
                      tone={thread.status === 'resolved' ? 'success' : 'live'}
                    />
                    <span className="min-w-0">
                      <strong className="block text-sm">
                        {thread.stepId === null
                          ? 'Workflow'
                          : (steps.find((step) => step.id === thread.stepId)
                              ?.label ??
                            thread.stepLabel ??
                            'Removed step')}
                      </strong>
                      <span className="mt-1 line-clamp-2 block wrap-anywhere text-sm text-muted-foreground">
                        {thread.preview}
                      </span>
                      <span className="mt-2 block text-xs text-muted-foreground">
                        {thread.commentCount} comments · {thread.status}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </QueryView>
      <LoadMore
        subject="discussions"
        label="More discussions"
        hasNextPage={query.hasNextPage}
        loading={query.isFetchingNextPage}
        failed={query.isFetchNextPageError}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </>
  );
}
