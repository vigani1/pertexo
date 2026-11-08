import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { WorkflowPromotionHistory } from '@pertexo/contracts';
import {
  RecentLog,
  RecentLogEntry,
} from '@/components/patterns/lists/recent-log';
import type { PromotionScope } from '../data/promotions.api';
import { promotionHistoryQuery } from '../data/promotions.queries';

type Promotion = WorkflowPromotionHistory['items'][number];

const OUTCOMES: Readonly<Record<Promotion['mode'], string>> = {
  draft: 'as a draft',
  publish: 'and published it',
  request_approval: 'and asked for a publishing review',
};

function PromotionEntry({
  workspaceId,
  item,
}: Readonly<{ workspaceId: string; item: Promotion }>) {
  const sent = item.sourceWorkspaceId === workspaceId;
  return (
    <RecentLogEntry
      tone={item.mode === 'publish' ? 'success' : 'neutral'}
      at={item.occurredAt}
      label={
        <span className="font-normal text-muted-foreground [overflow-wrap:anywhere]">
          <b className="font-medium text-foreground">{item.actorName}</b>{' '}
          promoted{' '}
          <Link
            className="inline-link font-medium text-foreground"
            to="/w/$workspaceId/workflows/$workflowId"
            params={{ workspaceId, workflowId: item.workflowId }}
          >
            {item.workflowName}
          </Link>{' '}
          {sent ? 'to the linked workspace' : 'into this workspace'}{' '}
          {OUTCOMES[item.mode]}
        </span>
      }
      action={
        item.publicationRequestId === null || sent ? undefined : (
          <Link
            className="inline-link mt-1 inline-block py-0.5 text-xs"
            to="/w/$workspaceId/publish-reviews/$requestId"
            params={{ workspaceId, requestId: item.publicationRequestId }}
          >
            Open the review
          </Link>
        )
      }
    />
  );
}

/** Promotions this workspace sent or received, in the audit ledger's words. */
export function PromotionHistory({ scope }: { scope: PromotionScope }) {
  const history = useInfiniteQuery(promotionHistoryQuery(scope));
  return (
    <RecentLog
      headingLevel="h2"
      query={history}
      items={history.data?.pages.flatMap((page) => page.items)}
      itemKey={(item) => item.id}
      dayOf={(item) => item.occurredAt}
      renderItem={(item) => (
        <PromotionEntry workspaceId={scope.workspaceId} item={item} />
      )}
      copy={{
        title: 'Promotion history',
        note: 'kept as long as the audit log',
        subject: 'promotions',
        loadMoreLabel: 'Load older promotions',
        empty: 'No promotions yet. Each one you send or receive appears here.',
      }}
    />
  );
}
