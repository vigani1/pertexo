import { QUERY_FRESHNESS } from '@/lib/api/query-timings';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import {
  readPublicationReview,
  readReviewOverview,
  type ReviewScope,
} from './publication-review.api';
export const publicationReviewKeys = {
  scope: (scope: ReviewScope) =>
    [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'publication-review',
    ] as const,
};
export function reviewOverviewOptions(
  scope: ReviewScope,
  workflowId: string,
  revision: number,
) {
  return queryOptions({
    queryKey: [
      ...publicationReviewKeys.scope(scope),
      'workflow',
      workflowId,
      revision,
    ],
    queryFn: ({ signal }) => readReviewOverview(scope, workflowId, signal),
    staleTime: QUERY_FRESHNESS.none,
    // Each save asks again for the new revision. Until it answers, the last
    // answer stands, so Publish doesn't go dead under a click; the server
    // still decides whether publishing needs a review.
    placeholderData: keepPreviousData,
  });
}
export function publicationReviewOptions(scope: ReviewScope, reviewId: string) {
  return queryOptions({
    queryKey: [...publicationReviewKeys.scope(scope), 'request', reviewId],
    queryFn: ({ signal }) => readPublicationReview(scope, reviewId, signal),
    staleTime: QUERY_FRESHNESS.none,
  });
}
