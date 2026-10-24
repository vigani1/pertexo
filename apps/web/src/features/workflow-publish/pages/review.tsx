import { SuitePublishNotice } from '../components/test-suites/publish-notice';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { QueryView } from '@/components/patterns/states/query-view';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { formatDateTime } from '@/lib/format/time';
import { publicationReviewOptions } from '../data/reviews/queries';
import type { ReviewScope } from '../data/reviews/api';
import { ReviewCandidate } from '../components/reviews/candidate';
import { ReviewDecision } from '../components/reviews/decision';
export function PublicationReviewPage({
  scope,
  reviewId,
  capabilities,
}: Readonly<{
  scope: ReviewScope;
  reviewId: string;
  capabilities: readonly string[];
}>) {
  const query = useQuery(publicationReviewOptions(scope, reviewId));
  return (
    <QueryView
      query={query}
      resource="Publication review"
      loading={<Skeleton className="h-48 w-full" />}
    >
      {({ request, graph, liveGraph }) => (
        <div className="flex min-w-0 max-w-4xl flex-col gap-6">
          <PageHeader>
            <PageHeaderTitle>Publication review</PageHeaderTitle>
            <Status tone={reviewTone(request.status)}>{request.status}</Status>
          </PageHeader>
          <section className="flex flex-col gap-3 rounded-xl border border-border p-5">
            <h2 className="font-semibold [overflow-wrap:anywhere]">
              {request.workflowName} · draft revision {request.draftRevision}
            </h2>
            <p className="text-sm text-muted-foreground">
              Requested by {request.requesterName} on{' '}
              {formatDateTime(request.createdAt)}. Expires{' '}
              {formatDateTime(request.expiresAt)}.
            </p>
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              {request.note}
            </p>
            {request.deciderName === null ? null : (
              <p className="text-sm text-muted-foreground">
                {request.deciderName} decided{' '}
                {request.decidedAt === null
                  ? ''
                  : formatDateTime(request.decidedAt)}
                .
              </p>
            )}
            {request.comment === null ? null : (
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {request.comment}
              </p>
            )}
          </section>
          {graph === null ? null : (
            <>
              <SuitePublishNotice
                scope={{ ...scope, workflowId: request.workflowId }}
                savedDraftCurrent
                enabled={request.canDecide}
                capabilities={capabilities}
              />
              <ReviewCandidate graph={graph} liveGraph={liveGraph} />
            </>
          )}
          <ReviewDecision key={request.id} scope={scope} request={request} />
          <Link
            to="/w/$workspaceId/workflows/$workflowId"
            params={{
              workspaceId: scope.workspaceId,
              workflowId: request.workflowId,
            }}
            className="text-sm underline underline-offset-4"
          >
            Open workflow editor
          </Link>
        </div>
      )}
    </QueryView>
  );
}

function reviewTone(status: string) {
  if (status === 'pending') return 'waiting';
  if (status === 'approved') return 'success';
  return 'attention';
}
