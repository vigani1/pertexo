import { queryOptions } from '@tanstack/react-query';
import {
  readPublicationReview,
  readReviewOverview,
  type ReviewScope,
} from './api';
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
    staleTime: 0,
  });
}
export function publicationReviewOptions(scope: ReviewScope, reviewId: string) {
  return queryOptions({
    queryKey: [...publicationReviewKeys.scope(scope), 'request', reviewId],
    queryFn: ({ signal }) => readPublicationReview(scope, reviewId, signal),
    staleTime: 0,
  });
}
