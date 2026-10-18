import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { StatusGlyph } from '@/components/ui/status';
import { formatDateTime } from '@/lib/format/time';
import type { PromotionScope } from '../data/promotions.api';
import { promotionHistoryQuery } from '../data/promotions.queries';
export function PromotionHistory({ scope }: { scope: PromotionScope }) {
  const history = useInfiniteQuery(promotionHistoryQuery(scope));
  return (
    <section className="grid gap-3" aria-label="Promotion history">
      <h2 className="text-lg font-semibold">Promotion history</h2>
      <p className="text-sm text-muted-foreground">
        Metadata follows each workspace’s audit retention. Published versions
        keep their source correspondence while retained.
      </p>
      <ol className="divide-y divide-border">
        {history.data?.pages
          .flatMap((page) => page.items)
          .map((item) => (
            <li key={item.id} className="flex items-start gap-3 py-3">
              <StatusGlyph tone="success" />
              <div className="min-w-0 break-words text-sm">
                <Link
                  className="inline-link"
                  to="/w/$workspaceId/workflows/$workflowId"
                  params={{
                    workspaceId: scope.workspaceId,
                    workflowId: item.workflowId,
                  }}
                >
                  {item.workflowName}
                </Link>
                <p>
                  {item.actorName} ·{' '}
                  {item.mode === 'draft'
                    ? 'Created draft'
                    : item.mode === 'publish'
                      ? 'Published'
                      : 'Requested approval'}
                </p>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={item.occurredAt}
                >
                  {formatDateTime(item.occurredAt)}
                </time>
              </div>
            </li>
          ))}
      </ol>
      {history.isPending ? (
        <p role="status">Loading promotion history…</p>
      ) : null}
      {history.isError ? (
        <Notice tone="warning">
          Promotion history could not be loaded.{' '}
          <Button variant="ghost" onClick={() => void history.refetch()}>
            Retry
          </Button>
        </Notice>
      ) : null}
      {history.data?.pages[0]?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No promotions yet.</p>
      ) : null}
      {history.hasNextPage ? (
        <Button
          variant="outline"
          className="self-start"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          Older promotions
        </Button>
      ) : null}
    </section>
  );
}
